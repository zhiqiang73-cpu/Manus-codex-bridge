import crypto from 'node:crypto';
import {
  getHostId,
  hasSharingScope,
  loadCredentials,
  saveCredentials,
} from './store.js';

/**
 * 官方 Sign in with ChatGPT —— ChatGPT plan usage（开源 / 本地个人项目通道）
 * 文档：https://developers.openai.com/siwc/token-sharing-open-source/sign-in
 *
 * 关键点：
 *  - 首次注册用 client_id=dynamic_agent_client，回调会返回签发的 oaiapp_* client_id
 *  - 之后复用签发的 client_id（不再传 agent_name_hint）
 *  - 不伪装 codex_cli_rs，不设置 originator，不碰 chatgpt.com/backend-api/*
 */

export const DISCOVERY_URL = 'https://auth.openai.com/.well-known/openid-configuration';
export const FALLBACK = {
  issuer: 'https://auth.openai.com',
  authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize',
  token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token',
  jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
};

export const RESOURCE = 'https://api.openai.com/v1';
export const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export const APP_NAME = 'Codex Flex Bridge PoC';
export const DYNAMIC_CLIENT_ID = 'dynamic_agent_client';

let discovery = null;
export async function getDiscovery() {
  if (discovery) return discovery;
  try {
    const res = await fetch(DISCOVERY_URL);
    if (!res.ok) throw new Error(`discovery ${res.status}`);
    const json = await res.json();
    discovery = {
      issuer: json.issuer || FALLBACK.issuer,
      authorization_endpoint: json.authorization_endpoint || FALLBACK.authorization_endpoint,
      token_endpoint: json.token_endpoint || FALLBACK.token_endpoint,
      jwks_uri: json.jwks_uri || FALLBACK.jwks_uri,
    };
  } catch (err) {
    discovery = { ...FALLBACK, discovery_error: err.message };
  }
  return discovery;
}

/* ---------------- PKCE / 随机值 ---------------- */

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomValue(bytes = 32) {
  return b64url(crypto.randomBytes(bytes));
}

/* ---------------- 授权事务 ---------------- */

let pending = null; // { state, nonce, verifier, redirectUri, createdAt, clientId, mode }

export function getPending() {
  if (!pending) return null;
  return {
    state: pending.state,
    createdAt: new Date(pending.createdAt).toISOString(),
    mode: pending.mode,
    clientIdUsed: pending.clientId,
    redirectUri: pending.redirectUri,
  };
}

export function cancelPending() {
  pending = null;
}

/**
 * 开始一次授权，返回浏览器应打开的地址。
 * @param {{ redirectUri: string }} options
 */
export async function startAuthorization({ redirectUri }) {
  const disc = await getDiscovery();
  const saved = loadCredentials();
  const issuedClientId = saved?.client_id && saved.client_id !== DYNAMIC_CLIENT_ID ? saved.client_id : null;

  const state = randomValue(24);
  const nonce = randomValue(24);
  const verifier = randomValue(64);
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());

  pending = {
    state,
    nonce,
    verifier,
    redirectUri,
    createdAt: Date.now(),
    clientId: issuedClientId || DYNAMIC_CLIENT_ID,
    mode: issuedClientId ? 'reauthorize' : 'dynamic_registration',
    idTokenHint: saved?.id_token || null,
    email: saved?.email || null,
  };

  const url = new URL(disc.authorization_endpoint);
  const params = {
    response_type: 'code',
    client_id: pending.clientId,
    redirect_uri: redirectUri,
    scope: SCOPES,
    resource: RESOURCE,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  };
  if (pending.mode === 'dynamic_registration') {
    params.agent_name_hint = APP_NAME;
    params.ext_agent_host_id = getHostId();
  } else {
    params.ext_agent_host_id = getHostId();
    if (pending.idTokenHint) params.id_token_hint = pending.idTokenHint;
    if (pending.email) params.login_hint = pending.email;
  }
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  return { url: url.toString(), mode: pending.mode, clientIdUsed: pending.clientId, redirectUri, scopes: SCOPES, resource: RESOURCE };
}

/* ---------------- 回调处理 ---------------- */

export async function handleCallback(searchParams) {
  if (!pending) throw new Error('没有进行中的授权事务，请重新点击登录');
  const flow = pending;

  const returnedState = searchParams.get('state');
  if (returnedState !== flow.state) {
    throw new Error(`state 校验失败（期望 ${flow.state.slice(0, 8)}…，实际 ${String(returnedState).slice(0, 8)}…）`);
  }
  const error = searchParams.get('error');
  if (error) {
    const desc = searchParams.get('error_description') || '';
    const err = new Error(`授权被拒绝：${error}${desc ? ' - ' + desc : ''}`);
    err.step = 'authorization';
    err.oauthError = error;
    throw err;
  }
  const code = searchParams.get('code');
  if (!code) throw new Error('回调缺少 code');

  const callbackClientId = searchParams.get('client_id');
  const callbackScope = searchParams.get('scope');

  // 首次注册必须拿到签发的 client_id；不得把 dynamic_agent_client 当成签发 id 保存
  let issuedClientId = flow.clientId;
  if (flow.mode === 'dynamic_registration') {
    if (!callbackClientId || callbackClientId === DYNAMIC_CLIENT_ID) {
      const err = new Error('首次注册的回调没有返回签发的 client_id，注册不完整');
      err.step = 'registration';
      throw err;
    }
    issuedClientId = callbackClientId;
  } else if (callbackClientId && callbackClientId !== flow.clientId) {
    const err = new Error(`回调返回了不同的 client_id（${callbackClientId}），已拒绝以免覆盖已选账号的注册`);
    err.step = 'registration';
    throw err;
  }

  const disc = await getDiscovery();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: issuedClientId,
    code,
    code_verifier: flow.verifier,
    redirect_uri: flow.redirectUri,
    resource: RESOURCE,
  });

  const res = await fetch(disc.token_endpoint, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  let tokens = null;
  try {
    tokens = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  if (!res.ok) {
    const err = new Error(`换取令牌失败 (${res.status})：${tokens?.error || text.slice(0, 300)}`);
    err.step = 'token_exchange';
    err.httpStatus = res.status;
    err.errorType = tokens?.error || null;
    err.errorDescription = tokens?.error_description || null;
    throw err;
  }

  const grantedScopes = String(tokens.scope || callbackScope || '').split(/\s+/).filter(Boolean);
  const verification = await verifyIdToken(tokens.id_token, issuedClientId, flow.nonce).catch((err) => ({
    ok: false,
    error: err.message,
  }));

  const record = {
    email: verification.claims?.email || null,
    issuer: disc.issuer,
    subject: verification.claims?.sub || null,
    client_id: issuedClientId,
    ext_agent_host_id: getHostId(),
    id_token: tokens.id_token,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || null,
    token_type: tokens.token_type || 'Bearer',
    expires_in: tokens.expires_in || null,
    scopes: grantedScopes,
    saved_at: new Date().toISOString(),
  };
  saveCredentials(record);
  pending = null;

  return {
    connected: true,
    sharing: grantedScopes.includes('chatgpt.tokens.use.direct'),
    grantedScopes,
    email: record.email,
    subject: record.subject,
    clientId: issuedClientId,
    mode: flow.mode,
    idTokenVerification: verification,
    tokenResponseKeys: Object.keys(tokens).filter((k) => !/token|code|secret/i.test(k)),
  };
}

/* ---------------- ID token 校验 ---------------- */

async function verifyIdToken(idToken, clientId, expectedNonce) {
  if (typeof idToken !== 'string') return { ok: false, error: '令牌响应没有 id_token' };
  const disc = await getDiscovery();
  const [h, p, s] = idToken.split('.');
  if (!h || !p || !s) return { ok: false, error: 'id_token 不是合法 JWT' };

  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));

  const jwksRes = await fetch(disc.jwks_uri);
  const jwks = await jwksRes.json();
  const jwk = (jwks.keys || []).find((k) => k.kid === header.kid) || (jwks.keys || [])[0];
  if (!jwk) return { ok: false, error: 'JWKS 中没有可用公钥', claims: payload };

  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const signatureOk = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${h}.${p}`),
    key,
    Buffer.from(s, 'base64url'),
  );

  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  const checks = {
    signature: signatureOk,
    issuer: payload.iss === disc.issuer,
    audience: aud.includes(clientId),
    notExpired: typeof payload.exp === 'number' && payload.exp * 1000 > Date.now(),
  };
  if (expectedNonce) checks.nonce = payload.nonce === expectedNonce;
  const ok = Object.values(checks).every(Boolean);
  return { ok, checks, claims: payload, error: ok ? null : `校验未通过：${Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(', ')}` };
}

/**
 * 事后复核已保存的 id_token（签名 / issuer / audience / 有效期）。
 * nonce 是每次授权事务独有的，只能在回调当时校验，这里不复算。
 */
export async function verifyStoredIdentity() {
  const creds = loadCredentials();
  if (!creds?.id_token) return { ok: false, error: '没有保存的 id_token' };
  const result = await verifyIdToken(creds.id_token, creds.client_id, null);
  return {
    ...result,
    note: 'nonce 已在回调时校验；此处复核签名/issuer/audience/有效期',
    subject: result.claims?.sub || null,
    email: result.claims?.email || null,
  };
}

/* ---------------- 刷新 ---------------- */

export async function refreshAccessToken() {
  const creds = loadCredentials();
  if (!creds?.refresh_token) throw new Error('没有 refresh_token');
  const disc = await getDiscovery();
  const res = await fetch(disc.token_endpoint, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: creds.client_id,
      refresh_token: creds.refresh_token,
      resource: RESOURCE,
    }),
  });
  const text = await res.text();
  const tokens = JSON.parse(text);
  if (!res.ok) throw new Error(`刷新失败 (${res.status})：${tokens?.error || text.slice(0, 200)}`);
  const scopes = String(tokens.scope || '').split(/\s+/).filter(Boolean);
  const next = {
    ...creds,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || creds.refresh_token,
    id_token: tokens.id_token || creds.id_token,
    expires_in: tokens.expires_in || creds.expires_in,
    scopes: scopes.length ? scopes : creds.scopes,
    saved_at: new Date().toISOString(),
  };
  saveCredentials(next);
  return next;
}

/** 取一个可用的 access token（不打印、不外泄） */
export async function getAccessToken() {
  const creds = loadCredentials();
  if (!creds?.access_token) {
    const err = new Error('尚未连接 ChatGPT');
    err.errorType = 'not_connected';
    err.httpStatus = 401;
    throw err;
  }
  if (!hasSharingScope(creds)) {
    const err = new Error('已登录，但未授予 ChatGPT plan usage（缺少 chatgpt.tokens.use.direct）');
    err.errorType = 'no_plan_usage';
    err.httpStatus = 403;
    throw err;
  }
  return creds.access_token;
}

export function connectionSummary() {
  const creds = loadCredentials();
  if (!creds?.access_token) return { connected: false };
  return {
    connected: true,
    sharing: hasSharingScope(creds),
    email: creds.email,
    subject: creds.subject,
    clientId: creds.client_id,
    hostId: creds.ext_agent_host_id,
    scopes: creds.scopes || [],
    savedAt: creds.saved_at,
    hasRefreshToken: Boolean(creds.refresh_token),
  };
}
