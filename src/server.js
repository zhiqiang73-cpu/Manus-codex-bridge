import http from 'node:http';
import { renderPage } from './page.js';
import { installFetchRecorder, getOutboundRecords, calledChatGptBackendApi, distinctEndpoints } from './outbound.js';
import { LOGS_DIR, clearCredentials, hasSharingScope, loadCredentials, readLog, writeLog } from './store.js';
import {
  APP_NAME,
  DYNAMIC_CLIENT_ID,
  RESOURCE,
  SCOPES,
  cancelPending,
  connectionSummary,
  getPending,
  handleCallback,
  startAuthorization,
  verifyStoredIdentity,
} from './oauth.js';
import { MODELS_ENDPOINT, RESPONSES_ENDPOINT, listModels, runInference } from './inference.js';

const PORT = Number(process.env.POC_PORT || 18888);
const HOST = '127.0.0.1';
const REDIRECT_URI = `http://${HOST}:${PORT}/auth/callback`;
const TEST_PROMPT = 'Reply with exactly: OFFICIAL_CHATGPT_PLAN_TEST_OK';

/* ---------- 环境净化：明确不使用 API Key ---------- */
const apiKeyWasPresent = Boolean(process.env.OPENAI_API_KEY);
delete process.env.OPENAI_API_KEY; // unset / ignore
process.env.OPENAI_API_KEY = '';
const otherKeyVars = Object.keys(process.env).filter((k) => /^OPENAI_(API_KEY|ORG|PROJECT|BASE_URL)$/.test(k) && k !== 'OPENAI_API_KEY');

installFetchRecorder(LOGS_DIR);

const lastRun = { models: null, inference: null, oauth: null };

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) });
  res.end(html);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 512 * 1024) req.destroy();
    });
    req.on('end', () => resolve(raw));
  });
}

function parseJson(raw) {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

/* ---------- poc-result.json ---------- */

/** 授权证据落盘（不含任何 token），重启后依然可查 */
async function writeOauthEvidence(extra = {}) {
  const creds = loadCredentials();
  if (!creds?.access_token) return null;
  let verification = null;
  try {
    verification = await verifyStoredIdentity();
  } catch (err) {
    verification = { ok: false, error: err.message };
  }
  const evidence = {
    at: new Date().toISOString(),
    flow_mode: extra.mode || 'dynamic_registration',
    client_id: creds.client_id,
    host_id: creds.ext_agent_host_id,
    email: creds.email,
    subject: creds.subject,
    granted_scopes: creds.scopes || [],
    chatgpt_plan_usage_granted: hasSharingScope(creds),
    has_refresh_token: Boolean(creds.refresh_token),
    id_token_verification: verification,
    ...extra,
  };
  writeLog('oauth-result.json', evidence);
  return evidence;
}

function buildPocResult() {
  const summary = connectionSummary();
  const models = lastRun.models;
  const inference = lastRun.inference;
  const oauth = lastRun.oauth;
  const oauthEvidence = readLog('oauth-result.json');

  const result = {
    generated_at: new Date().toISOString(),
    poc: 'official-chatgpt-plan',

    oauth_login: Boolean(summary.connected),
    oauth_flow: oauth?.mode || oauthEvidence?.flow_mode || null,
    oauth_scope: summary.scopes?.length ? summary.scopes.join(' ') : null,
    oauth_client_id: summary.clientId || null,
    oauth_host_id: summary.hostId || null,
    oauth_id_token_verified: oauth?.idTokenVerification?.ok ?? oauthEvidence?.id_token_verification?.ok ?? null,
    oauth_id_token_checks: oauth?.idTokenVerification?.checks ?? oauthEvidence?.id_token_verification?.checks ?? null,
    chatgpt_plan_usage_granted: Boolean(summary.sharing),

    models_endpoint: MODELS_ENDPOINT,
    models_success: Boolean(models?.ok),
    models_http_status: models?.httpStatus ?? null,
    models_count: models?.models?.length ?? null,
    models_returned: models?.models?.map((m) => m.id) ?? null,

    selected_model: inference?.model ?? models?.selectedModel ?? null,
    inference_endpoint: RESPONSES_ENDPOINT,
    inference_success: Boolean(inference?.ok),
    inference_http_status: inference?.httpStatus ?? null,
    inference_completed_event: inference?.completed ?? null,
    response_text: inference?.text ?? null,
    response_usage: inference?.usage ?? null,

    used_sk_api_key: false,
    openai_api_key_present_in_env: apiKeyWasPresent,
    openai_api_key_action: apiKeyWasPresent ? 'unset + ignored' : 'not present; nothing to unset',
    other_openai_env_vars: otherKeyVars,
    used_chatgpt_backend_api: calledChatGptBackendApi(),
    outbound_endpoints: distinctEndpoints(),

    failed_step: null,
    error: null,
  };

  if (!result.oauth_login) result.failed_step = result.failed_step || 'OAuth';
  else if (!result.chatgpt_plan_usage_granted) result.failed_step = 'ChatGPT plan usage scope (chatgpt.tokens.use.direct) not granted';
  else if (!result.models_success) result.failed_step = 'Models';
  else if (!result.inference_success) result.failed_step = 'Responses';

  if (inference && !inference.ok) {
    result.error = {
      step: 'Responses',
      http_status: inference.httpStatus,
      endpoint: inference.endpoint,
      error_type: inference.errorType,
      error_message: inference.errorMessage,
    };
  } else if (models && !models.ok) {
    result.error = { step: 'Models', http_status: models.httpStatus, endpoint: models.endpoint, error_type: models.errorType, error_message: models.errorMessage };
  }

  writeLog('poc-result.json', result);
  return result;
}

/* ---------- 路由 ---------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  try {
    if (path === '/') return sendHtml(res, 200, renderPage());
    if (path === '/favicon.ico') return res.writeHead(204).end();

    // 授权回调（redirect_uri 与授权请求完全一致：http://127.0.0.1:18888/auth/callback）
    if (path === '/auth/callback') {
      try {
        const outcome = await handleCallback(url.searchParams);
        lastRun.oauth = outcome;
        await writeOauthEvidence({ mode: outcome.mode });
        buildPocResult();
        res.writeHead(302, { location: '/?connected=1' });
        return res.end();
      } catch (err) {
        lastRun.oauth = { error: err.message, step: err.step || 'callback', oauthError: err.oauthError || null };
        buildPocResult();
        res.writeHead(302, { location: `/?error=${encodeURIComponent(err.message)}` });
        return res.end();
      }
    }

    if (path === '/api/state') {
      const summary = connectionSummary();
      return sendJson(res, 200, {
        ...summary,
        pending: getPending(),
        redirectUri: REDIRECT_URI,
        scopesRequested: SCOPES,
        resource: RESOURCE,
        dynamicClientId: DYNAMIC_CLIENT_ID,
        appName: APP_NAME,
        apiKeyUnset: true,
      });
    }

    if (path === '/api/login' && req.method === 'POST') {
      try {
        const flow = await startAuthorization({ redirectUri: REDIRECT_URI });
        lastRun.oauth = { mode: flow.mode, clientIdUsed: flow.clientIdUsed };
        return sendJson(res, 200, flow);
      } catch (err) {
        return sendJson(res, 200, { error: err.message });
      }
    }

    if (path === '/api/logout' && req.method === 'POST') {
      cancelPending();
      clearCredentials();
      lastRun.models = null;
      lastRun.inference = null;
      buildPocResult();
      return sendJson(res, 200, { ok: true });
    }

    if (path === '/api/models' && req.method === 'POST') {
      try {
        const { models, rawCount } = await listModels();
        lastRun.models = { ok: true, endpoint: MODELS_ENDPOINT, httpStatus: 200, models, rawCount };
        buildPocResult();
        return sendJson(res, 200, { ok: true, endpoint: MODELS_ENDPOINT, httpStatus: 200, models, rawCount });
      } catch (err) {
        lastRun.models = {
          ok: false,
          endpoint: MODELS_ENDPOINT,
          httpStatus: err.httpStatus ?? null,
          errorType: err.errorType ?? null,
          errorMessage: err.errorMessage ?? err.message,
        };
        buildPocResult();
        return sendJson(res, 200, {
          ok: false,
          step: err.step || 'models',
          httpStatus: err.httpStatus ?? null,
          endpoint: MODELS_ENDPOINT,
          errorType: err.errorType ?? null,
          errorMessage: err.errorMessage ?? err.message,
        });
      }
    }

    if (path === '/api/infer' && req.method === 'POST') {
      const body = parseJson(await readBody(req));
      const model = body.model;
      if (!model) return sendJson(res, 400, { error: '缺少 model' });
      const prompt = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt : TEST_PROMPT;
      const outcome = await runInference({ model, prompt });
      lastRun.inference = { ...outcome, model, prompt };
      buildPocResult();
      return sendJson(res, 200, { ...outcome, model, prompt });
    }

    if (path === '/api/evidence') {
      const summary = connectionSummary();
      return sendJson(res, 200, {
        api_key_used: false,
        openai_api_key_present_in_env: apiKeyWasPresent,
        openai_api_key_action: 'unset + ignored',
        chatgpt_backend_api_called: calledChatGptBackendApi(),
        codex_endpoints_called: getOutboundRecords().filter((r) => /backend-api\/codex/.test(r.endpoint)).map((r) => r.endpoint),
        distinct_endpoints: distinctEndpoints(),
        request_count: getOutboundRecords().length,
        records: getOutboundRecords(),
        credential_file_has_tokens: Boolean(loadCredentials()?.access_token),
        credential_file_path: 'state/credentials.json (0600, 不写入 logs/)',
        connection: { connected: summary.connected, clientId: summary.clientId, hostId: summary.hostId, scopes: summary.scopes },
      });
    }

    if (path === '/api/poc-result') {
      return sendJson(res, 200, readLog('poc-result.json') || buildPocResult());
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log('Official ChatGPT Plan PoC');
  console.log(`  URL        : http://${HOST}:${PORT}/`);
  console.log(`  redirect   : ${REDIRECT_URI}`);
  console.log(`  client_id  : ${DYNAMIC_CLIENT_ID}（首次注册）→ 之后用签发的 oaiapp_*`);
  console.log(`  scopes     : ${SCOPES}`);
  console.log(`  resource   : ${RESOURCE}`);
  console.log(`  OPENAI_API_KEY: ${apiKeyWasPresent ? '存在 → 已 unset 并忽略' : '不存在'}`);
  console.log(`  logs       : ${LOGS_DIR}`);
  console.log('按 Ctrl+C 停止。');
  // 已有凭据时补齐授权证据（复核 id_token 签名/issuer/audience/有效期）
  writeOauthEvidence().catch(() => {});
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try {
      buildPocResult();
    } catch {
      /* 忽略 */
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  });
}
