#!/usr/bin/env node
/**
 * chatgpt-oauth-login.mjs
 * ---------------------------------------------------------------------------
 * 严格按 OpenAI 官方 "Sign in with ChatGPT / ChatGPT Plan Usage"（OSS + 本地托管）
 * 文档实现 OAuth Authorization Code + PKCE 首次注册与授权。
 *
 * 官方依据：
 *   https://developers.openai.com/siwc/token-sharing-open-source
 *   https://developers.openai.com/siwc/token-sharing-open-source/sign-in
 *   https://developers.openai.com/siwc/token-sharing-open-source/token-reference
 *   https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
 *
 * 关键参数（与官方文档一致）：
 *   授权端点   https://auth.openai.com/api/accounts/authorize
 *   令牌端点   https://auth.openai.com/api/accounts/oauth/token
 *   首次注册   client_id=dynamic_agent_client + agent_name_hint + ext_agent_host_id
 *   回调       http://127.0.0.1:<port>/auth/callback （scheme/host/path 固定，仅端口可变）
 *   scope      openid profile email offline_access resource.invoke chatgpt.tokens.use.direct
 *   resource   https://api.openai.com/v1
 *   PKCE       S256
 *   回调返回   code, state, client_id(oaiapp_...)
 *
 * 本脚本绝不读取、绝不依赖 Codex 客户端旧式 ~/.codex/auth.json。
 *
 * 用法：
 *   node chatgpt-oauth-login.mjs                 # 首次注册（或复用已保存 client_id 重新授权）
 *   node chatgpt-oauth-login.mjs --new           # 强制新注册（新的 ChatGPT 账号）
 *   node chatgpt-oauth-login.mjs --port=1455     # 指定回调端口
 *   node chatgpt-oauth-login.mjs --url-only      # 只打印授权 URL，不启动监听
 *   node chatgpt-oauth-login.mjs --verify-only   # 只校验已保存凭证
 * ---------------------------------------------------------------------------
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ----------------------------- 常量 ---------------------------------------

const AUTH_BASE = 'https://auth.openai.com';
const AUTHORIZE_URL = `${AUTH_BASE}/api/accounts/authorize`;
const TOKEN_URL = `${AUTH_BASE}/api/accounts/oauth/token`;
const DISCOVERY_URL = `${AUTH_BASE}/.well-known/openid-configuration`;
const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'];
const CLIENT_ID_FIRST_REGISTRATION = 'dynamic_agent_client';
const APP_NAME = 'Manus Codex Relay';

const CONFIG_DIR = path.resolve(
  process.env.CHATGPT_PLAN_CONFIG_DIR || path.join(os.homedir(), '.config', 'chatgpt-plan-relay')
);
const HOST_FILE = path.join(CONFIG_DIR, 'host.json');
const CRED_FILE = path.join(CONFIG_DIR, 'credentials.json');
const PENDING_FILE = path.join(CONFIG_DIR, 'pending-registration.json');

// ----------------------------- 参数 ---------------------------------------

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
const FORCE_NEW = ARGS.flags.has('new');
const URL_ONLY = ARGS.flags.has('url-only');
const VERIFY_ONLY = ARGS.flags.has('verify-only');
const OPEN_PICKER_ONLY = ARGS.flags.has('open-picker');
const PORT_PREF = parseInt(ARGS.kv.port || '1455', 10);

// ----------------------------- 工具 ---------------------------------------

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const nowSec = () => Math.floor(Date.now() / 1000);
const iso = (s) => new Date(s * 1000).toISOString();

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

function fingerprint(secret) {
  if (!secret) return null;
  return crypto.createHash('sha256').update(secret).digest('hex').slice(0, 12);
}

function maskTail(secret, keep = 4) {
  if (!secret) return '(none)';
  return `***${String(secret).slice(-keep)}`;
}

/** 原子写入 + 0600 权限（官方要求） */
function writeSecure(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, typeof data === 'string' ? data : JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* 忽略 */
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function decodeJwt(token) {
  try {
    const [h, p] = token.split('.');
    const dec = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    return { header: dec(h), payload: dec(p) };
  } catch {
    return null;
  }
}

// ----------------------------- 主机 ID ------------------------------------

/** 生成/复用 ext_agent_host_id（官方推荐 urn:uuid:，也可用 JWK 指纹） */
function ensureHostId() {
  const existing = readJson(HOST_FILE);
  if (existing?.ext_agent_host_id) return existing.ext_agent_host_id;

  // 官方推荐格式：RFC 9278 JWK thumbprint URI
  let hostId;
  try {
    const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
    const thumb = b64url(crypto.createHash('sha256').update(canonical).digest());
    hostId = `urn:ietf:params:oauth:jwk-thumbprint:sha-256:${thumb}`;
  } catch {
    hostId = `urn:uuid:${crypto.randomUUID()}`;
  }
  writeSecure(HOST_FILE, { ext_agent_host_id: hostId, created_at: new Date().toISOString() });
  return hostId;
}

// ----------------------------- ID token 校验 ------------------------------

async function fetchJwks() {
  const disc = await (await fetch(DISCOVERY_URL)).json();
  const jwksUri = disc.jwks_uri || `${AUTH_BASE}/.well-known/jwks.json`;
  const jwks = await (await fetch(jwksUri)).json();
  return { jwks, issuer: disc.issuer || AUTH_BASE, jwksUri };
}

/** 按官方要求校验 ID token：签名 / issuer / audience / exp / nonce */
async function verifyIdToken(idToken, expectedClientId, expectedNonce) {
  const result = { valid: false, checks: {}, payload: null, error: null };
  const decoded = decodeJwt(idToken);
  if (!decoded) {
    result.error = 'ID token 不是合法 JWT';
    return result;
  }
  const { header, payload } = decoded;
  result.payload = payload;

  try {
    const { jwks, issuer } = await fetchJwks();
    const jwk = (jwks.keys || []).find((k) => k.kid === header.kid) || (jwks.keys || [])[0];
    if (!jwk) throw new Error('JWKS 中找不到匹配的 kid');
    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const [h, p, s] = idToken.split('.');
    result.checks.signature = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${h}.${p}`),
      key,
      Buffer.from(s, 'base64url')
    );
  } catch (e) {
    result.checks.signature = false;
    result.error = `签名校验失败：${e.message}`;
  }

  const iss = payload.iss || '';
  result.checks.issuer = iss === AUTH_BASE || iss === 'https://auth.openai.com';
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  result.checks.audience = expectedClientId ? aud.includes(expectedClientId) : true;
  result.checks.expiry = (payload.exp || 0) > nowSec();
  result.checks.nonce = expectedNonce ? payload.nonce === expectedNonce : true;

  result.valid = Object.values(result.checks).every(Boolean);
  return result;
}

// ----------------------------- 凭证保存 -----------------------------------

function saveCredentials({ idToken, accessToken, refreshToken, expiresIn, scope, email, subject, clientId, hostId, tokenType, earliestRefreshAt }) {
  const record = {
    email: email || null,
    issuer: AUTH_BASE,
    subject: subject || null,
    client_id: clientId,
    ext_agent_host_id: hostId,
    id_token: idToken,
    access_token: accessToken,
    refresh_token: refreshToken || null,
    token_type: tokenType || 'Bearer',
    expires_in: expiresIn ?? null,
    earliest_refresh_at: earliestRefreshAt ?? null,
    scopes: String(scope || '').split(/\s+/).filter(Boolean).sort(),
    saved_at: new Date().toISOString(),
  };
  writeSecure(CRED_FILE, record);
  return record;
}

// ----------------------------- 校验与报告 ---------------------------------

function inspectAccessToken(accessToken) {
  const d = decodeJwt(accessToken);
  const p = d?.payload || {};
  const scope = String(p.scope || '');
  return {
    aud: p.aud,
    audOk: p.aud === RESOURCE,
    scope,
    scopes: scope.split(/\s+/).filter(Boolean),
    hasDirectScope: scope.split(/\s+/).includes('chatgpt.tokens.use.direct'),
    iss: p.iss,
    client_id: p.client_id,
    iat: p.iat,
    exp: p.exp,
    lifetimeSeconds: p.exp && p.iat ? p.exp - p.iat : null,
    expiresAt: p.exp ? iso(p.exp) : null,
    remainingSeconds: p.exp ? p.exp - nowSec() : null,
    sub: p.sub,
  };
}

async function printReport(record, { idTokenCheck, tokenResponse }) {
  const line = '─'.repeat(74);
  const at = inspectAccessToken(record.access_token);
  console.log(`\n${line}\n【官方 Sign in with ChatGPT 授权结果】\n${line}`);
  console.log(`  issued client_id      ${record.client_id}${String(record.client_id).startsWith('oaiapp_') ? '  ✅ 官方签发格式' : '  ⚠️ 非 oaiapp_ 前缀'}`);
  console.log(`  ext_agent_host_id     ${record.ext_agent_host_id}`);
  console.log(`  账号邮箱              ${record.email || '(未提供)'}`);
  console.log(`  subject               ${record.subject || '(未知)'}`);
  console.log(`\n  access token aud      ${at.aud}  ${at.audOk ? '✅ 与官方要求一致' : '❌ 不等于 ' + RESOURCE}`);
  console.log(`  access token iss      ${at.iss}`);
  console.log(`  granted scopes        ${at.scopes.join(' ')}`);
  console.log(`  chatgpt.tokens.use.direct  ${at.hasDirectScope ? '✅ 已授权' : '❌ 未授权（不得继续推理）'}`);
  console.log(`  expires_in            ${tokenResponse?.expires_in ?? '(响应未提供)'} 秒`);
  console.log(`  token 实际生命周期     ${at.lifetimeSeconds} 秒（${(at.lifetimeSeconds / 3600).toFixed(2)} 小时）`);
  console.log(`  access token 到期      ${at.expiresAt}（剩余 ${at.remainingSeconds} 秒）`);
  console.log(`  earliest_refresh_at   ${tokenResponse?.earliest_refresh_at ?? '(未提供)'}`);
  console.log(`  refresh_token         ${record.refresh_token ? `已获得（指纹 ${fingerprint(record.refresh_token)}，尾 ${maskTail(record.refresh_token)}）` : '❌ 未获得'}`);
  console.log(`  access_token 指纹      ${fingerprint(record.access_token)}（尾 ${maskTail(record.access_token)}）`);
  if (idTokenCheck) {
    console.log(`\n  ID token 校验：`);
    for (const [k, v] of Object.entries(idTokenCheck.checks)) console.log(`    ${k.padEnd(10)} ${v ? '✅' : '❌'}`);
    if (idTokenCheck.error) console.log(`    error      ${idTokenCheck.error}`);
  }
  console.log(`\n  凭证已保存（0600）    ${CRED_FILE}`);
  console.log(line);

  // 关键闸门
  const lifetimeOk = at.lifetimeSeconds !== null && at.lifetimeSeconds <= 7200;
  console.log('\n【闸门检查】');
  console.log(`  aud == https://api.openai.com/v1     ${at.audOk ? '✅' : '❌'}`);
  console.log(`  scope 含 chatgpt.tokens.use.direct   ${at.hasDirectScope ? '✅' : '❌'}`);
  console.log(`  access token 约 3600 秒（非 ~10 天） ${lifetimeOk ? '✅' : '❌ 拿到的仍是长生命周期 token'}`);
  console.log(`  refresh_token 已获得                 ${record.refresh_token ? '✅' : '❌'}`);
  const allOk = at.audOk && at.hasDirectScope && lifetimeOk && record.refresh_token;
  console.log(`\n  ${allOk ? '✅ 全部通过，可以进入 /v1/models 与 /v1/responses 测试' : '❌ 存在未通过项，按用户要求不得继续后续测试'}`);
  console.log(line);
  if (allOk) await launchRelayAndOpenPicker();
  return allOk;
}

// --------------------- 授权成功后：起中继 + 弹选模型页 ---------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 授权成功后自动收尾：
 *   1. 若中继未运行，后台拉起 codex-relay.mjs
 *   2. 等中继就绪
 *   3. 直接打开选模型页面
 * 让"授权成功"和"选模型"连成一步，不需要手动再起服务。
 */
async function launchRelayAndOpenPicker() {
  const port = parseInt(process.env.RELAY_PORT || '8787', 10);
  const base = `http://127.0.0.1:${port}`;
  const healthy = () =>
    fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) })
      .then((r) => r.ok)
      .catch(() => false);

  console.log('\n【收尾：启动中继并打开选模型页】');

  let ok = await healthy();
  if (ok) {
    console.log('  · 中继已在运行，直接复用');
  } else {
    const relay = path.join(path.dirname(fileURLToPath(import.meta.url)), 'codex-relay.mjs');
    if (!fs.existsSync(relay)) {
      console.log(`  ⚠️ 未找到 ${relay}，请手动启动中继后访问 ${base}/`);
      return;
    }
    spawn(process.execPath, [relay, `--port=${port}`, '--no-open'], { detached: true, stdio: 'ignore' }).unref();
    console.log(`  · 已后台启动中继 ${base}`);
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      if (await healthy()) {
        ok = true;
        break;
      }
    }
    console.log(`  · 中继就绪 ${ok ? '✅' : '❌ 启动超时'}`);
  }
  if (!ok) return;

  const page = `${base}/`;
  try {
    openBrowser(page);
    console.log(`  · 已打开选模型页面 ${page} ✅`);
  } catch {
    console.log(`  · 请手动打开 ${page}`);
  }
}

// ----------------------------- 授权流程 -----------------------------------

async function exchangeCode({ code, clientId, codeVerifier, redirectUri }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    resource: RESOURCE,
  });
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 保留原文 */
  }
  return { status: r.status, ok: r.ok, json, text };
}

async function runFlow() {
  const hostId = ensureHostId();
  const existing = readJson(CRED_FILE);
  const pending = readJson(PENDING_FILE);

  let clientId;
  let agentNameHint = null;
  if (FORCE_NEW || !existing?.client_id) {
    clientId = CLIENT_ID_FIRST_REGISTRATION;
    agentNameHint = APP_NAME;
  } else {
    clientId = existing.client_id;
  }

  // 每次尝试都生成全新的 state / nonce / PKCE
  const state = b64url(crypto.randomBytes(24));
  const nonce = b64url(crypto.randomBytes(24));
  const codeVerifier = b64url(crypto.randomBytes(48));
  const codeChallenge = b64url(crypto.createHash('sha256').update(codeVerifier).digest());

  const port = PORT_PREF;
  const redirectUri = `http://127.0.0.1:${port}/auth/callback`;

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES.join(' '),
    resource: RESOURCE,
    state,
    nonce,
    code_challenge_method: 'S256',
    code_challenge: codeChallenge,
  });
  if (agentNameHint) params.set('agent_name_hint', agentNameHint);
  params.set('ext_agent_host_id', hostId);
  if (!FORCE_NEW && existing?.id_token) params.set('id_token_hint', existing.id_token);
  if (!FORCE_NEW && existing?.email) params.set('login_hint', existing.email);

  const authUrl = `${AUTHORIZE_URL}?${params.toString()}`;

  console.log('【授权请求】');
  console.log(`  client_id        ${clientId}${clientId === CLIENT_ID_FIRST_REGISTRATION ? '（首次注册入口）' : '（已签发的正式 client_id）'}`);
  console.log(`  ext_agent_host_id ${hostId}`);
  console.log(`  redirect_uri     ${redirectUri}`);
  console.log(`  scope            ${SCOPES.join(' ')}`);
  console.log(`  resource         ${RESOURCE}`);
  console.log(`\n授权 URL（含敏感 hint，勿外传）：\n${authUrl}\n`);
  const urlFile = path.join(CONFIG_DIR, 'pending-auth-url.txt');
  writeSecure(urlFile, authUrl);
  console.log(`授权 URL 同时写入：${urlFile}（0600，授权完成后请删除）\n`);

  if (URL_ONLY) return;

  const listenerPromise = new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (url.pathname !== '/auth/callback') {
        res.writeHead(404).end('not found');
        return;
      }
      const q = Object.fromEntries(url.searchParams.entries());
      // 过期尝试留下的浏览器标签可能把旧回调打到这里：忽略它，继续等待本次尝试
      if (q.state !== state) {
        console.log('⚠️ 收到 state 不匹配的回调（来自上一次尝试），已忽略并继续等待…');
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h2>这是过期的授权回调</h2><p>请回到最新打开的授权页面重新完成授权。</p>');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        q.error
          ? `<h2>授权失败</h2><p>${q.error}: ${q.error_description || ''}</p>`
          : '<h2>✅ 授权成功</h2><p>请返回终端查看结果，可以关闭此窗口。</p>'
      );
      server.close();
      resolve(q);
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => console.log(`✔ 回调监听已启动 http://127.0.0.1:${port}/auth/callback`));
  });

  // 打开系统浏览器
  try {
    if (!openBrowser(authUrl)) console.log('  （未能自动打开浏览器，请手动访问上面的链接）');
    console.log('✔ 已尝试打开系统浏览器');
  } catch {
    console.log('⚠️ 无法自动打开浏览器，请手动访问上面的授权 URL');
  }

  console.log('⏳ 等待浏览器回调…（请在浏览器中完成登录、选择工作区并同意使用 ChatGPT plan）');
  const q = await listenerPromise;

  if (q.error) {
    console.error(`\n✖ 授权被拒绝或失败：${q.error} ${q.error_description || ''}`);
    if (q.error === 'access_denied') console.error('  说明用户拒绝了 consent，或该账号未启用 ChatGPT plan usage。');
    process.exit(3);
  }
  if (q.state !== state) {
    console.error('\n✖ state 不匹配，拒绝该回调（可能的 CSRF）');
    process.exit(4);
  }

  const issuedClientId = q.client_id || (clientId !== CLIENT_ID_FIRST_REGISTRATION ? clientId : null);
  if (!issuedClientId) {
    console.error('\n✖ 回调未返回签发的 client_id，注册视为未完成');
    process.exit(5);
  }
  if (clientId !== CLIENT_ID_FIRST_REGISTRATION && q.client_id && q.client_id !== clientId) {
    console.error(`\n✖ 回调返回了不同的 client_id（${q.client_id} ≠ ${clientId}），按官方要求拒绝`);
    process.exit(6);
  }
  console.log(`✔ 回调成功，签发 client_id = ${issuedClientId}`);
  writeSecure(PENDING_FILE, { client_id: issuedClientId, ext_agent_host_id: hostId, at: new Date().toISOString() });

  console.log('⏳ 交换授权码…');
  const ex = await exchangeCode({ code: q.code, clientId: issuedClientId, codeVerifier, redirectUri });
  if (!ex.ok || !ex.json?.access_token) {
    console.error(`\n✖ 令牌交换失败 HTTP ${ex.status}`);
    console.error(`  ${ex.text.slice(0, 600)}`);
    process.exit(7);
  }
  const t = ex.json;

  const idCheck = t.id_token ? await verifyIdToken(t.id_token, issuedClientId, nonce) : null;
  const idPayload = idCheck?.payload || {};
  const email = idPayload.email || null;
  const subject = idPayload.sub || null;

  const record = saveCredentials({
    idToken: t.id_token,
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresIn: t.expires_in,
    scope: t.scope,
    email,
    subject,
    clientId: issuedClientId,
    hostId,
    tokenType: t.token_type,
    earliestRefreshAt: t.earliest_refresh_at,
  });

  await printReport(record, { idTokenCheck: idCheck, tokenResponse: t });
}

async function verifyOnly() {
  const rec = readJson(CRED_FILE);
  if (!rec) {
    console.error(`✖ 未找到凭证文件 ${CRED_FILE}`);
    process.exit(2);
  }
  const at = inspectAccessToken(rec.access_token);
  console.log('【已保存凭证校验】');
  console.log(`  client_id   ${rec.client_id}`);
  console.log(`  aud         ${at.aud} ${at.audOk ? '✅' : '❌'}`);
  console.log(`  scopes      ${at.scopes.join(' ')}`);
  console.log(`  direct      ${at.hasDirectScope ? '✅' : '❌'}`);
  console.log(`  生命周期     ${at.lifetimeSeconds} 秒`);
  console.log(`  剩余         ${at.remainingSeconds} 秒`);
  console.log(`  refresh     ${rec.refresh_token ? '有' : '无'}`);
}

const main = async () => {
  if (OPEN_PICKER_ONLY) return launchRelayAndOpenPicker();
  if (VERIFY_ONLY) return verifyOnly();
  await runFlow();
};

main().catch((e) => {
  console.error(`\n✖ 未预期错误：${e?.stack || e}`);
  process.exit(1);
});
