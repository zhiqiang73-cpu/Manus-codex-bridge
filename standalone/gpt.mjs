#!/usr/bin/env node
/**
 * gpt.mjs —— 命令行里"选 GPT 模型并调用"的统一入口
 * ---------------------------------------------------------------------------
 * 让 Manus 任务（在本机跑终端）或你自己，都能显式指定用哪个 GPT 模型，
 * 走本机中继 → 官方 ChatGPT Plan Usage 结算。
 *
 * 用法：
 *   node gpt.mjs --list                        列出账号可用模型
 *   node gpt.mjs --default                     查看当前默认模型
 *   node gpt.mjs --set-default gpt-5.6-terra   设置默认模型（写入 relay-config.json）
 *   node gpt.mjs "你的问题"                     用默认模型提问
 *   node gpt.mjs -m gpt-6-astra "你的问题"      指定模型提问
 *   node gpt.mjs -m gpt-5.6-sol --stream "…"   流式输出
 *   cat file.txt | node gpt.mjs -m gpt-6-astra 从 stdin 读提示词
 *   node gpt.mjs -m gpt-6-astra --json "…"     输出完整 JSON（含 usage）
 *
 * 环境变量：
 *   RELAY_BASE   默认 http://127.0.0.1:8787
 *   RELAY_TOKEN  若中继启用了本地鉴权则需提供
 * ---------------------------------------------------------------------------
 */

const BASE = (process.env.RELAY_BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
const TOKEN = process.env.RELAY_TOKEN || '';

function parseArgs(argv) {
  const out = { flags: new Set(), kv: {}, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-m' || a === '--model') out.kv.model = argv[++i];
    else if (a.startsWith('--model=')) out.kv.model = a.slice(8);
    else if (a.startsWith('--set-default=')) out.kv.setDefault = a.slice(14);
    else if (a === '--set-default') out.kv.setDefault = argv[++i];
    else if (a === '--system') out.kv.system = argv[++i];
    else if (a.startsWith('--system=')) out.kv.system = a.slice(9);
    else if (a.startsWith('--')) out.flags.add(a.slice(2));
    else out.rest.push(a);
  }
  return out;
}

const A = parseArgs(process.argv.slice(2));
const headers = { 'Content-Type': 'application/json' };
if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

async function api(pathname, init) {
  const r = await fetch(`${BASE}${pathname}`, { headers, ...init });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 保留原文 */
  }
  if (!r.ok) {
    const msg = json?.error?.message || text.slice(0, 400);
    throw new Error(`HTTP ${r.status}: ${msg}`);
  }
  return json ?? text;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').trim();
}

const die = (m) => {
  console.error(`✖ ${m}`);
  process.exit(1);
};

async function main() {
  // 中继可达性
  try {
    await api('/health');
  } catch (e) {
    die(`连不上中继 ${BASE}\n  请先启动：node codex-relay.mjs\n  (${e.message})`);
  }

  if (A.flags.has('help')) {
    console.log((await import('node:fs')).readFileSync(new URL(import.meta.url), 'utf8').split('---')[1]);
    return;
  }

  if (A.flags.has('list')) {
    const ml = await api('/v1/models');
    const cur = (await api('/admin/config')).defaultModel;
    console.log('该 ChatGPT 账号可用模型：\n');
    for (const m of ml.data) {
      const mark = m.id === cur ? ' ← 默认' : '';
      const vis = m.visibility === 'list' ? '' : `  [visibility=${m.visibility}]`;
      console.log(`  ${m.id.padEnd(22)} ${(m.display_name || '').padEnd(20)}${vis}${mark}`);
    }
    console.log('\n用法：node gpt.mjs -m <模型> "你的问题"');
    return;
  }

  if (A.flags.has('default')) {
    const c = await api('/admin/config');
    console.log(`当前默认模型：${c.defaultModel}`);
    console.log(`可选：${c.listable.join(', ')}`);
    return;
  }

  if (A.kv.setDefault) {
    const r = await api('/admin/default-model', { method: 'POST', body: JSON.stringify({ model: A.kv.setDefault }) });
    console.log(`✔ 默认模型已设为 ${r.defaultModel}`);
    return;
  }

  // 单次调用
  let prompt = A.rest.join(' ').trim();
  if (!prompt) prompt = await readStdin();
  if (!prompt) die('没有提示词。用法：node gpt.mjs -m gpt-6-astra "你的问题"');

  const cfg = await api('/admin/config');
  const model = A.kv.model || cfg.defaultModel;
  const stream = A.flags.has('stream');

  const body = { model, stream, messages: [{ role: 'user', content: prompt }] };
  if (A.kv.system) body.messages.unshift({ role: 'system', content: A.kv.system });

  if (stream) {
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!r.ok) die(`HTTP ${r.status}: ${(await r.text()).slice(0, 400)}`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let usage = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const blk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const l of blk.split('\n')) {
          if (!l.startsWith('data:')) continue;
          const p = l.slice(5).trim();
          if (!p || p === '[DONE]') continue;
          let j;
          try {
            j = JSON.parse(p);
          } catch {
            continue;
          }
          const d = j.choices?.[0]?.delta?.content;
          if (d) process.stdout.write(d);
          if (j.usage) usage = j.usage;
        }
      }
    }
    process.stdout.write('\n');
    if (usage) console.error(`\n[model=${model} usage=${JSON.stringify(usage)}]`);
    return;
  }

  const r = await api('/v1/chat/completions', { method: 'POST', body: JSON.stringify(body) });
  if (A.flags.has('json')) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  const msg = r.choices?.[0]?.message || {};
  if (msg.content) console.log(msg.content);
  if (msg.tool_calls) console.log(`[tool_calls] ${JSON.stringify(msg.tool_calls)}`);
  if (r.usage) console.error(`[model=${model} usage=${JSON.stringify(r.usage)}]`);
}

main().catch((e) => die(e.message));
