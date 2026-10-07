#!/usr/bin/env node
/**
 * codex-relay.mjs —— 官方 Sign in with ChatGPT / ChatGPT Plan Usage 中继（默认版本）
 * ---------------------------------------------------------------------------
 * 上游完全走 OpenAI 官方公开端点，不使用任何 backend-api：
 *
 *   Local OpenAI-compatible client
 *        ↓  http://127.0.0.1:8787/v1
 *   codex-relay
 *        ↓  official Sign in with ChatGPT OAuth access token
 *   https://api.openai.com/v1/responses
 *        ↓
 *   ChatGPT Plan Usage
 *
 * 官方依据：
 *   developers.openai.com/siwc/token-sharing-open-source/models-and-inference
 *   developers.openai.com/siwc/token-sharing-open-source/preview-limitations
 *   developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
 *
 * 实测约束（2026-10-07 验证）：
 *   - 顶层 {type:"message", role:"system"} 会被拒：400 "System messages are not allowed"
 *   - 必须用 instructions 承载系统提示
 *   - tools 必须是扁平格式（name/description/parameters 在顶层），嵌套 function:{} 会 400
 *   - temperature / top_p 等参数会被拒：400 "Unsupported parameter"
 *   - 每次请求 store:false + stream:true
 *
 * 端点：
 *   GET  /health                健康检查 + token 状态
 *   GET  /v1/models             该 ChatGPT 账号真实可用模型（官方 /v1/models）
 *   POST /v1/chat/completions   OpenAI Chat Completions（流式/非流式、tool_calls、工具结果往返）
 *   POST /v1/responses          Responses API 透传
 *
 * 凭证：~/.config/chatgpt-plan-relay/credentials.json（由 chatgpt-oauth-login.mjs 生成）
 * 刷新：官方 grant_type=refresh_token + 轮换，原子写回，串行化避免并发竞争。
 * ---------------------------------------------------------------------------
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

// ----------------------------- 配置 ---------------------------------------

function parseArgs(argv) {
  const out = { flags: new Set(), kv: {} };
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const b = a.slice(2);
    const eq = b.indexOf('=');
    if (eq === -1) out.flags.add(b);
    else out.kv[b.slice(0, eq)] = b.slice(eq + 1);
  }
  return out;
}
const ARGS = parseArgs(process.argv.slice(2));
const PORT = parseInt(ARGS.kv.port || process.env.RELAY_PORT || '8787', 10);
const HOST = ARGS.kv.host || '127.0.0.1';
const VERBOSE = ARGS.flags.has('verbose');
const NO_OPEN = ARGS.flags.has('no-open');
const RELAY_TOKEN = process.env.RELAY_TOKEN || '';

const CONFIG_DIR = path.resolve(
  process.env.CHATGPT_PLAN_CONFIG_DIR || path.join(os.homedir(), '.config', 'chatgpt-plan-relay')
);
const CRED_FILE = path.join(CONFIG_DIR, 'credentials.json');
const RELAY_CONFIG_FILE = path.join(CONFIG_DIR, 'relay-config.json');

const AUTH_BASE = 'https://auth.openai.com';
const TOKEN_URL = `${AUTH_BASE}/api/accounts/oauth/token`;
const RESOURCE = 'https://api.openai.com/v1';
const MODELS_URL = `${RESOURCE}/models`;
const RESPONSES_URL = `${RESOURCE}/responses`;
const REQUIRED_SCOPE = 'chatgpt.tokens.use.direct';
const REFRESH_SKEW_SECONDS = parseInt(process.env.REFRESH_SKEW_SECONDS || '120', 10);

/** 跨平台打开浏览器：macOS 用 open，Linux 用 xdg-open，Windows 用 start */
function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch {
    return false;
  }
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const vlog = (...a) => VERBOSE && log(...a);
const fp = (s) => (s ? crypto.createHash('sha256').update(s).digest('hex').slice(0, 12) : null);
const tail = (s) => (s ? `***${String(s).slice(-4)}` : '(none)');

function decodeJwt(token) {
  try {
    const [, p] = token.split('.');
    return JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** 原子写入 + 0600 */
function writeSecure(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* 忽略 */
  }
}

// ----------------------------- 凭证与刷新 ---------------------------------

class Credentials {
  constructor() {
    this.record = null;
    this.refreshPromise = null; // 串行化，避免并发刷新竞争同一个轮换 token
  }

  load() {
    if (!fs.existsSync(CRED_FILE)) {
      throw new Error(
        `找不到官方凭证 ${CRED_FILE}\n  请先运行：node chatgpt-oauth-login.mjs`
      );
    }
    this.record = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
    if (!this.record.access_token) throw new Error(`${CRED_FILE} 缺少 access_token`);
    return this;
  }

  get claims() {
    return decodeJwt(this.record?.access_token) || {};
  }

  get remainingSeconds() {
    const exp = this.claims.exp;
    return exp ? exp - Math.floor(Date.now() / 1000) : null;
  }

  get status() {
    const c = this.claims;
    return {
      configFile: CRED_FILE,
      clientId: this.record?.client_id || null,
      email: this.record?.email || null,
      hostId: this.record?.ext_agent_host_id || null,
      aud: c.aud || null,
      scopes: String(c.scope || '').split(/\s+/).filter(Boolean),
      hasDirectScope: String(c.scope || '').split(/\s+/).includes(REQUIRED_SCOPE),
      tokenFingerprint: fp(this.record?.access_token),
      tokenTail: tail(this.record?.access_token),
      expiresAt: c.exp ? new Date(c.exp * 1000).toISOString() : null,
      remainingSeconds: this.remainingSeconds,
      hasRefreshToken: !!this.record?.refresh_token,
    };
  }

  async refresh() {
    if (this.refreshPromise) return this.refreshPromise; // 复用进行中的刷新
    this.refreshPromise = this._doRefresh().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  async _doRefresh() {
    const rt = this.record?.refresh_token;
    const clientId = this.record?.client_id;
    if (!rt || !clientId) {
      log('✖ 无法刷新：缺少 refresh_token 或 client_id，需要重新运行 OAuth 登录');
      return false;
    }
    log('→ 刷新 access token…');
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: rt,
      resource: RESOURCE, // 官方要求带上 resource；不传 scope 以保留原授权
    });
    let r;
    try {
      r = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch (e) {
      log(`✖ 刷新网络失败：${e.message}`);
      return false;
    }
    const text = await r.text();
    let j = null;
    try {
      j = JSON.parse(text);
    } catch {
      /* 保留原文 */
    }
    if (!r.ok || !j?.access_token) {
      const code = j?.error || j?.error_code || '';
      log(`✖ 刷新失败 HTTP ${r.status} code=${code}：${text.slice(0, 200)}`);
      if (
        ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'].includes(code)
      ) {
        log('  refresh_token 已不可用，需重新运行 node chatgpt-oauth-login.mjs');
      }
      return false;
    }

    // 官方要求：access_token / refresh_token / 到期与 scope 一起原子替换
    const next = {
      ...this.record,
      access_token: j.access_token,
      refresh_token: j.refresh_token || this.record.refresh_token,
      expires_in: j.expires_in ?? this.record.expires_in,
      earliest_refresh_at: j.earliest_refresh_at ?? this.record.earliest_refresh_at,
      scopes: String(j.scope || this.record.scopes?.join(' ') || '').split(/\s+/).filter(Boolean).sort(),
      saved_at: new Date().toISOString(),
    };
    writeSecure(CRED_FILE, next);
    this.record = next;
    const c = this.claims;
    log(`✔ 刷新成功，新 token 指纹 ${fp(next.access_token)}，到期 ${c.exp ? new Date(c.exp * 1000).toISOString() : '?'}`);
    if (j.refresh_token) log(`  refresh_token 已轮换（新尾 ${tail(j.refresh_token)}）`);
    return true;
  }

  /** 确保 token 有效；临近过期时刷新 */
  async ensureFresh() {
    const remain = this.remainingSeconds;
    if (remain !== null && remain < REFRESH_SKEW_SECONDS) {
      await this.refresh();
    }
    return this.record.access_token;
  }

  /** 401/403 时强制刷新一次再重试 */
  async forceRefresh() {
    return this.refresh();
  }
}

const creds = new Credentials();

// ----------------------------- 模型目录 -----------------------------------

let modelCache = { at: 0, list: [] };

async function fetchModels(force = false) {
  if (!force && modelCache.list.length && Date.now() - modelCache.at < 60_000) return modelCache.list;
  const token = await creds.ensureFresh();
  const r = await fetch(MODELS_URL, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`GET /v1/models 失败 HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const arr = j.models || j.data || [];
  const list = arr.map((m) => ({
    slug: m.slug || m.id,
    display_name: m.display_name || m.id,
    visibility: m.visibility || null,
  }));
  modelCache = { at: Date.now(), list };
  return list;
}

function readRelayConfig() {
  try {
    return JSON.parse(fs.readFileSync(RELAY_CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeRelayConfig(cfg) {
  writeSecure(RELAY_CONFIG_FILE, cfg);
}

/** 默认模型：优先使用用户在模型选择页里持久化的选择 */
function defaultModel() {
  const cfg = readRelayConfig();
  if (cfg.defaultModel && modelCache.list.some((m) => m.slug === cfg.defaultModel)) return cfg.defaultModel;
  const listable = modelCache.list.filter((m) => m.visibility === 'list');
  return (listable[0] || modelCache.list[0])?.slug || 'gpt-6-astra';
}

const MODEL_ALIASES = {
  'gpt-5': null, // 交给 defaultModel
  'gpt-5-codex': null,
  'gpt-4o': null,
  'gpt-4': null,
};

function resolveModel(requested) {
  if (!requested) return defaultModel();
  const known = modelCache.list.map((m) => m.slug);
  if (known.includes(requested)) return requested;
  if (requested in MODEL_ALIASES) return defaultModel();
  return requested; // 未知模型交给上游判断，避免静默改写用户意图
}

// ----------------------- Chat Completions → Responses ----------------------

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === 'string' ? c : c?.text || '')).filter(Boolean).join('\n');
  }
  return '';
}

/** OpenAI 嵌套 function 格式 → 官方扁平格式（实测必需） */
function toFlatTools(tools) {
  const out = [];
  for (const t of tools || []) {
    if (t.type !== 'function') continue;
    const f = t.function || t;
    if (!f?.name) continue;
    out.push({
      type: 'function',
      name: f.name,
      description: f.description || '',
      parameters: f.parameters || { type: 'object', properties: {} },
      strict: false,
    });
  }
  return out;
}

function toResponsesToolChoice(tc, hasTools) {
  if (!hasTools) return undefined;
  if (!tc) return 'auto';
  if (typeof tc === 'string') return tc;
  if (tc.type === 'function') {
    const name = tc.function?.name || tc.name;
    return name ? { type: 'function', name } : 'auto';
  }
  return 'auto';
}

/** 官方路由拒绝顶层 system message item，因此系统提示一律折进 instructions */
function chatToResponses(body) {
  const messages = body.messages || [];
  const systemParts = [];
  const input = [];

  for (const m of messages) {
    const role = m.role;
    if (role === 'system' || role === 'developer') {
      const t = contentToText(m.content);
      if (t) systemParts.push(t);
      continue;
    }
    if (role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id || m.call_id || 'call_unknown',
        output: contentToText(m.content),
      });
      continue;
    }
    if (role === 'assistant') {
      for (const tc of m.tool_calls || []) {
        input.push({
          type: 'function_call',
          call_id: tc.id || `call_${crypto.randomUUID().slice(0, 8)}`,
          name: tc.function?.name || 'unknown',
          arguments: tc.function?.arguments || '{}',
        });
      }
      const t = contentToText(m.content);
      if (t) input.push({ role: 'assistant', content: t });
      continue;
    }
    input.push({ role: 'user', content: contentToText(m.content) });
  }

  const tools = toFlatTools(body.tools);
  const payload = {
    model: resolveModel(body.model),
    input,
    store: false,
    stream: true,
  };
  const instructions = systemParts.join('\n\n');
  if (instructions) payload.instructions = instructions;
  if (tools.length) {
    payload.tools = tools;
    const tc = toResponsesToolChoice(body.tool_choice, true);
    if (tc !== undefined) payload.tool_choice = tc;
    payload.parallel_tool_calls = false;
  }
  // 官方路由拒绝的字段一律不带：temperature / top_p / top_logprobs / max_output_tokens /
  // metadata / moderation / prompt / prompt_cache_retention / safety_identifier / truncation / user /
  // background / conversation / previous_response_id / max_tool_calls / multi_agent
  return payload;
}

// ----------------------------- 上游调用 -----------------------------------

async function callResponses(payload, { retryOn401 = true } = {}) {
  const token = await creds.ensureFresh();
  vlog(`→ POST ${RESPONSES_URL} model=${payload.model} input=${payload.input.length} tools=${(payload.tools || []).length}`);
  const r = await fetch(RESPONSES_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if ((r.status === 401 || r.status === 403) && retryOn401) {
    log(`⚠️ 上游返回 ${r.status}，尝试刷新 token 后重试一次`);
    if (await creds.forceRefresh()) return callResponses(payload, { retryOn401: false });
  }
  return r;
}

// ----------------------------- SSE 解析 -----------------------------------

async function readSse(stream, onEvent) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const l of block.split('\n')) {
        if (!l.startsWith('data:')) continue;
        const payload = l.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          onEvent(JSON.parse(payload));
        } catch {
          /* 跳过坏帧 */
        }
      }
    }
  }
}

// ----------------------------- 响应转换 -----------------------------------

const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const chunkBase = (id, model, created) => ({
  id,
  object: 'chat.completion.chunk',
  created,
  model,
  system_fingerprint: 'chatgpt-plan-usage',
});

function usageToOpenAI(u) {
  if (!u) return undefined;
  return {
    prompt_tokens: u.input_tokens || 0,
    completion_tokens: u.output_tokens || 0,
    total_tokens: u.total_tokens || 0,
  };
}

async function handleChatCompletions(req, res, body) {
  const payload = chatToResponses(body);
  const wantStream = body.stream !== false;
  const created = Math.floor(Date.now() / 1000);

  let upstream;
  try {
    upstream = await callResponses(payload);
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `中继无法连接上游：${e.message}`, type: 'relay_error' } }));
    return;
  }

  if (!upstream.ok) {
    const t = await upstream.text();
    log(`✖ 上游 HTTP ${upstream.status}：${t.slice(0, 200)}`);
    res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: t.slice(0, 1000), type: 'upstream_error', code: upstream.status } }));
    return;
  }

  if (!wantStream) {
    let text = '';
    const toolCalls = [];
    let usage = null;
    let failure = null;
    await readSse(upstream.body, (j) => {
      if (j.type === 'response.output_text.delta') text += j.delta || '';
      else if (j.type === 'response.output_text.done' && !text) text = j.text || '';
      else if (j.type === 'response.output_item.done' && j.item?.type === 'function_call') {
        toolCalls.push({
          id: j.item.call_id,
          type: 'function',
          function: { name: j.item.name, arguments: j.item.arguments || '{}' },
        });
      } else if (j.type === 'response.completed') usage = j.response?.usage || null;
      else if (j.type === 'response.failed') failure = j.response?.error || { message: 'failed' };
    });
    if (failure) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: failure.message || 'failed', code: failure.code, type: 'upstream_error' } }));
      return;
    }
    const message = { role: 'assistant', content: text || null };
    if (toolCalls.length) message.tool_calls = toolCalls;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: `chatcmpl-${crypto.randomUUID().slice(0, 12)}`,
        object: 'chat.completion',
        created,
        model: payload.model,
        choices: [{ index: 0, message, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
        usage: usageToOpenAI(usage),
      })
    );
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const id = `chatcmpl-${crypto.randomUUID().slice(0, 12)}`;
  let toolIndex = -1;
  const openToolCalls = new Map();
  let usage = null;
  let finish = 'stop';
  let sawToolCall = false;
  let sentRole = false;

  const emitRole = () => {
    if (sentRole) return;
    sentRole = true;
    sse(res, { ...chunkBase(id, payload.model, created), choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
  };

  try {
    await readSse(upstream.body, (j) => {
      if (j.type === 'response.output_text.delta' && j.delta) {
        emitRole();
        sse(res, { ...chunkBase(id, payload.model, created), choices: [{ index: 0, delta: { content: j.delta }, finish_reason: null }] });
      } else if (j.type === 'response.output_item.added' && j.item?.type === 'function_call') {
        emitRole();
        sawToolCall = true;
        toolIndex += 1;
        openToolCalls.set(j.item.id || j.item.call_id, toolIndex);
        sse(res, {
          ...chunkBase(id, payload.model, created),
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: toolIndex,
                    id: j.item.call_id || `call_${crypto.randomUUID().slice(0, 8)}`,
                    type: 'function',
                    function: { name: j.item.name || '', arguments: '' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
      } else if (j.type === 'response.function_call_arguments.delta') {
        const idx = openToolCalls.get(j.item_id) ?? toolIndex;
        sse(res, {
          ...chunkBase(id, payload.model, created),
          choices: [{ index: 0, delta: { tool_calls: [{ index: idx, function: { arguments: j.delta || '' } }] }, finish_reason: null }],
        });
      } else if (j.type === 'response.completed') {
        usage = j.response?.usage || null;
        if ((j.response?.output || []).some((i) => i.type === 'function_call')) finish = 'tool_calls';
      } else if (j.type === 'response.failed' || j.type === 'error') {
        const err = j.response?.error || j.error || {};
        sse(res, { error: { message: err.message || 'upstream failed', code: err.code, type: 'upstream_error' } });
      }
    });
  } catch (e) {
    vlog(`流中断：${e.message}`);
  }

  emitRole();
  // response.completed 的 output 数组可能为空，因此以流内是否出现 function_call 为准
  const finalFinish = sawToolCall ? 'tool_calls' : finish;
  sse(res, { ...chunkBase(id, payload.model, created), choices: [{ index: 0, delta: {}, finish_reason: finalFinish }] });
  if (usage) {
    sse(res, { ...chunkBase(id, payload.model, created), choices: [], usage: usageToOpenAI(usage) });
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

/** /v1/responses 透传（保持官方约束：store:false, stream:true） */
async function handleResponses(req, res, body) {
  const payload = {
    ...body,
    model: resolveModel(body.model),
    store: false,
    stream: true,
  };
  delete payload.temperature;
  delete payload.top_p;
  delete payload.max_output_tokens;

  let upstream;
  try {
    upstream = await callResponses(payload);
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `中继无法连接上游：${e.message}`, type: 'relay_error' } }));
    return;
  }
  res.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') || 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  if (!upstream.body) {
    res.end(await upstream.text());
    return;
  }
  const reader = upstream.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

// ----------------------------- 模型选择页 ---------------------------------

function modelPickerHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ChatGPT Plan Usage 中继 · 模型选择</title>
<style>
 :root{color-scheme:light dark}
 body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;margin:0;padding:32px;background:#f6f7f9;color:#111}
 .wrap{max-width:760px;margin:0 auto}
 h1{font-size:20px;margin:0 0 4px}
 .sub{color:#666;font-size:13px;margin-bottom:22px}
 .card{background:#fff;border:1px solid #e3e6ea;border-radius:12px;padding:8px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
 .row{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:8px;cursor:pointer}
 .row:hover{background:#f2f4f7}
 .row.sel{background:#eef4ff;outline:1px solid #c7dbff}
 .row input{accent-color:#2563eb;width:16px;height:16px}
 .slug{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
 .dn{color:#666;font-size:12px}
 .tag{margin-left:auto;font-size:11px;padding:2px 8px;border-radius:999px;background:#f0f1f3;color:#666}
 .bar{margin-top:18px;display:flex;gap:10px;align-items:center}
 button{background:#2563eb;color:#fff;border:0;border-radius:8px;padding:9px 18px;font-size:14px;cursor:pointer}
 button:disabled{opacity:.5;cursor:default}
 .msg{font-size:13px;color:#0a7a33}
 .cur{font-size:13px;color:#444;margin-top:14px}
 code{background:#f0f1f3;padding:1px 5px;border-radius:4px;font-size:12px}
 @media (prefers-color-scheme:dark){
  body{background:#0f1115;color:#e8eaed}
  .card{background:#171a21;border-color:#262b35}
  .row:hover{background:#1e232c}
  .row.sel{background:#16233c;outline-color:#2c4a7c}
  .dn,.sub{color:#9aa0a6}.cur{color:#c4c7cc}
  .tag{background:#232833;color:#9aa0a6}
  code{background:#232833}
 }
</style>
</head>
<body>
<div class="wrap">
  <h1>选择 GPT 模型</h1>
  <div class="sub">清单来自该 ChatGPT 账号的官方 <code>/v1/models</code>。保存后写入 <code>relay-config.json</code>，成为中继默认模型；单次请求仍可用 <code>model</code> 字段覆盖。</div>
  <div class="card" id="list">加载中…</div>
  <div class="bar">
    <button id="save" disabled>保存为默认模型</button>
    <span class="msg" id="msg"></span>
  </div>
  <div class="cur" id="cur"></div>
</div>
<script>
var models=[],current=null,picked=null;
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function render(){
  var el=document.getElementById('list');el.innerHTML='';
  models.forEach(function(m){
    var row=document.createElement('label');
    row.className='row'+(m.slug===picked?' sel':'');
    row.innerHTML='<input type="radio" name="m" value="'+esc(m.slug)+'"'+(m.slug===picked?' checked':'')+'>'+
      '<span><span class="slug">'+esc(m.slug)+'</span><br><span class="dn">'+esc(m.display_name||'')+'</span></span>'+
      '<span class="tag">'+esc(m.visibility||'')+'</span>';
    row.querySelector('input').onchange=function(){picked=m.slug;render();document.getElementById('save').disabled=false;};
    el.appendChild(row);
  });
}
async function load(){
  var c=await fetch('/admin/config').then(function(r){return r.json();});
  var ml=await fetch('/v1/models').then(function(r){return r.json();});
  models=(ml.data||[]).filter(function(m){return m.visibility==='list';}).map(function(m){return {slug:m.id||m.slug,display_name:m.display_name,visibility:m.visibility};});
  current=c.defaultModel;picked=current;
  document.getElementById('cur').innerHTML='当前默认模型：<code>'+esc(current)+'</code>';
  render();
}
document.getElementById('save').onclick=async function(){
  var r=await fetch('/admin/default-model',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:picked})});
  var j=await r.json();var msg=document.getElementById('msg');
  if(r.ok){current=j.defaultModel;msg.textContent='已保存：'+j.defaultModel;document.getElementById('save').disabled=true;
    document.getElementById('cur').innerHTML='当前默认模型：<code>'+esc(current)+'</code>';}
  else{msg.textContent='失败：'+((j.error&&j.error.message)||r.status);}
};
load();
</script>
</body>
</html>`;
}

// ----------------------------- OpenAPI ------------------------------------

function buildOpenApi(list, baseUrl) {
  const listable = list.filter((m) => m.visibility === 'list').map((m) => m.slug);
  return {
    openapi: '3.1.0',
    info: {
      title: 'ChatGPT Plan Usage Relay',
      version: '1.0.0',
      description:
        '通过官方 Sign in with ChatGPT OAuth，用 ChatGPT 套餐完成 Responses API 推理。model 留空时使用中继当前默认模型。',
    },
    servers: [{ url: baseUrl }],
    paths: {
      '/v1/chat/completions': {
        post: {
          operationId: 'chatCompletions',
          summary: '用 ChatGPT 套餐完成一次对话补全（可选模型）',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['messages'],
                  properties: {
                    model: {
                      type: 'string',
                      description: '要使用的 GPT 模型；留空则用中继默认模型',
                      enum: listable,
                      default: defaultModel(),
                    },
                    messages: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['role'],
                        properties: {
                          role: { type: 'string', enum: ['system', 'user', 'assistant', 'tool'] },
                          content: { type: 'string' },
                        },
                      },
                    },
                    stream: { type: 'boolean', default: false },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'OpenAI 兼容的补全结果' } },
        },
      },
      '/v1/models': {
        get: { operationId: 'listModels', summary: '列出该账号可用模型', responses: { 200: { description: '模型清单' } } },
      },
    },
  };
}

// ----------------------------- 服务器 -------------------------------------

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function authorized(req) {
  if (!RELAY_TOKEN) return true;
  const h = req.headers.authorization || '';
  const t = h.replace(/^Bearer\s+/i, '').trim() || req.headers['x-api-key'] || '';
  return t === RELAY_TOKEN;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  vlog(`${req.method} ${url.pathname}`);

  if (!authorized(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Unauthorized（本中继启用了 RELAY_TOKEN）', type: 'auth_error' } }));
    return;
  }

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(
          {
            ok: true,
            protocol: 'official Sign in with ChatGPT / ChatGPT Plan Usage',
            upstream: RESPONSES_URL,
            modelsEndpoint: MODELS_URL,
            credentials: creds.status,
          },
          null,
          2
        )
      );
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      const list = await fetchModels();
      const created = Math.floor(Date.now() / 1000);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: list.map((m) => ({
            id: m.slug,
            object: 'model',
            created,
            owned_by: 'chatgpt-plan-usage',
            display_name: m.display_name,
            visibility: m.visibility,
          })),
        })
      );
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      await handleChatCompletions(req, res, await readJsonBody(req));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/responses') {
      await handleResponses(req, res, await readJsonBody(req));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(modelPickerHtml());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/admin/config') {
      const list = await fetchModels();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(
          {
            defaultModel: defaultModel(),
            listable: list.filter((m) => m.visibility === 'list').map((m) => m.slug),
            available: list.map((m) => m.slug),
          },
          null,
          2
        )
      );
      return;
    }

    if (req.method === 'POST' && url.pathname === '/admin/default-model') {
      const body = await readJsonBody(req);
      const wanted = body.model || body.defaultModel;
      const list = await fetchModels();
      if (!wanted || !list.some((m) => m.slug === wanted)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { message: `模型不在该账号可用清单中：${wanted}`, available: list.map((m) => m.slug) },
          })
        );
        return;
      }
      const cfg = readRelayConfig();
      cfg.defaultModel = wanted;
      cfg.updatedAt = new Date().toISOString();
      writeRelayConfig(cfg);
      log(`默认模型已设为 ${wanted}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, defaultModel: wanted }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/openapi.json') {
      const list = await fetchModels();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(buildOpenApi(list, `http://${HOST}:${PORT}`), null, 2));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `未知路径 ${url.pathname}`, type: 'not_found' } }));
  } catch (e) {
    log(`✖ 处理失败：${e.stack || e}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: String(e.message || e), type: 'relay_error' } }));
    } else {
      res.end();
    }
  }
});

// ----------------------------- 启动 ---------------------------------------

async function startup() {
  try {
    creds.load();
  } catch (e) {
    log(`✖ ${e.message}`);
    process.exit(2);
  }
  const s = creds.status;
  log('ChatGPT Plan Usage 中继（官方协议版）启动');
  log(`  监听        http://${HOST}:${PORT}`);
  log(`  上游        ${RESPONSES_URL}`);
  log(`  凭证        ${s.configFile}`);
  log(`  client_id   ${s.clientId}`);
  log(`  账号        ${s.email || '(未知)'}`);
  log(`  aud         ${s.aud}`);
  log(`  scope       ${s.scopes.join(' ')}`);
  log(`  direct 权限 ${s.hasDirectScope ? '✅ 已授权' : '❌ 未授权（无法推理）'}`);
  log(`  token       ${s.tokenFingerprint}（尾 ${s.tokenTail}），剩余 ${s.remainingSeconds} 秒`);
  log(`  refresh     ${s.hasRefreshToken ? '有（过期前 2 分钟自动刷新 + 轮换，原子写回）' : '无'}`);
  log(`  本地鉴权    ${RELAY_TOKEN ? '已启用 RELAY_TOKEN' : '未启用（仅监听回环地址）'}`);
  try {
    const list = await fetchModels(true);
    const listable = list.filter((m) => m.visibility === 'list');
    log(`  可用模型    ${listable.map((m) => m.slug).join(', ')}`);
    log(`  默认模型    ${defaultModel()}`);
  } catch (e) {
    log(`  ⚠️ 拉取模型列表失败：${e.message}`);
  }
  server.listen(PORT, HOST, () => {
    const pageUrl = `http://${HOST}:${PORT}/`;
    if (NO_OPEN) {
      log(`  模型选择页  ${pageUrl}（--no-open 已禁用自动打开）`);
      return;
    }
    try {
      openBrowser(pageUrl);
      log(`  模型选择页  ${pageUrl}（已自动打开）`);
    } catch {
      log(`  模型选择页  ${pageUrl}（自动打开失败，请手动访问）`);
    }
  });
}

startup();

process.on('SIGINT', () => {
  log('收到 SIGINT，关闭中继');
  server.close(() => process.exit(0));
});
