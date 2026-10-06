import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPage } from './page.js';
import { installFetchRecorder, getOutboundRecords, calledChatGptBackendApi, distinctEndpoints } from './outbound.js';
import { LOGS_DIR, clearCredentials, hasSharingScope, loadCredentials, readLog, storageInfo, writeLog } from './store.js';
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
import { describeError, fromInferenceResult } from './errors.js';
import {
  chatSseChunks,
  chatToResponses,
  errorPayload,
  responsesSseFrames,
  toChatCompletion,
  toResponsesObject,
} from './openai-compat.js';

const TEST_PROMPT = 'Reply with exactly: OFFICIAL_CHATGPT_PLAN_TEST_OK';
const DEFAULT_PORT = Number(process.env.MCB_PORT || 18888);

/* ---------- 环境净化：明确不使用 API Key ---------- */
const apiKeyWasPresent = Boolean(process.env.OPENAI_API_KEY);
delete process.env.OPENAI_API_KEY;
process.env.OPENAI_API_KEY = '';

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

function sendSse(res, frames) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  for (const f of frames) res.write(f);
  res.end();
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1024 * 1024) req.destroy();
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

/* ---------- 证据落盘 ---------- */

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
    storage_backend: storageInfo().label,
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
    tool: 'manus-codex-bridge',

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

    selected_model: inference?.model ?? null,
    inference_endpoint: RESPONSES_ENDPOINT,
    inference_success: Boolean(inference?.ok),
    inference_http_status: inference?.httpStatus ?? null,
    inference_completed_event: inference?.completed ?? null,
    response_text: inference?.text ?? null,
    response_usage: inference?.usage ?? null,

    used_sk_api_key: false,
    openai_api_key_present_in_env: apiKeyWasPresent,
    openai_api_key_action: apiKeyWasPresent ? 'unset + ignored' : 'not present; nothing to unset',
    used_chatgpt_backend_api: calledChatGptBackendApi(),
    outbound_endpoints: distinctEndpoints(),

    failed_step: null,
    error: null,
  };

  if (!result.oauth_login) result.failed_step = 'OAuth';
  else if (!result.chatgpt_plan_usage_granted) result.failed_step = 'ChatGPT plan usage scope not granted';
  else if (models && !models.ok) result.failed_step = 'Models';
  else if (inference && !inference.ok) result.failed_step = 'Responses';

  if (inference && !inference.ok) {
    result.error = { step: 'Responses', ...fromInferenceResult(inference) };
  } else if (models && !models.ok) {
    result.error = {
      step: 'Models',
      http_status: models.httpStatus,
      endpoint: MODELS_ENDPOINT,
      error_type: models.errorType,
      error_message: models.errorMessage,
    };
  }

  writeLog('poc-result.json', result);
  return result;
}

/* ---------- 路由 ---------- */

export function startHttpServer({
  port = DEFAULT_PORT,
  host = '127.0.0.1',
  apiKey = null,
  callbackHost = '127.0.0.1',
} = {}) {
  // 官方要求回调必须是 127.0.0.1 回环地址，与监听地址无关。
  // 即使绑到 0.0.0.0 供局域网使用，回调仍固定为 127.0.0.1。
  const redirectUri = `http://${callbackHost}:${port}/auth/callback`;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || `${callbackHost}:${port}`}`);
    const route = url.pathname.replace(/\/+$/, '') || '/';

    try {
      /* ----- OpenAI 兼容端点（可用本地 API key 保护） ----- */
      if (route.startsWith('/v1/')) {
        try {
        if (apiKey) {
          const auth = req.headers.authorization || '';
          const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : '';
          if (supplied !== apiKey) {
            return sendJson(res, 401, { error: { message: 'Invalid local API key', type: 'invalid_request_error', code: 'invalid_api_key' } });
          }
        }

        if (route === '/v1/models' && req.method === 'GET') {
          try {
            const { models, rawCount } = await listModels();
            lastRun.models = { ok: true, endpoint: MODELS_ENDPOINT, httpStatus: 200, models, rawCount };
            return sendJson(res, 200, {
              object: 'list',
              data: models.map((m) => ({ id: m.id, object: 'model', created: 0, owned_by: 'openai', display_name: m.display_name })),
            });
          } catch (err) {
            const described = fromInferenceResult({ ok: false, httpStatus: err.httpStatus, errorType: err.errorType, errorMessage: err.errorMessage || err.message });
            return sendJson(res, described.httpStatus || 500, errorPayload(described));
          }
        }

        if ((route === '/v1/chat/completions' || route === '/v1/responses') && req.method === 'POST') {
          const body = parseJson(await readBody(req));
          const model = body.model;
          if (!model) return sendJson(res, 400, { error: { message: 'Missing required parameter: model', type: 'invalid_request_error', code: null } });

          let prompt = '';
          let instructions = body.instructions || undefined;
          if (route === '/v1/responses') {
            const input = body.input;
            if (typeof input === 'string') prompt = input;
            else if (Array.isArray(input)) {
              prompt = input
                .map((item) => (typeof item === 'string' ? item : item?.content ?? ''))
                .map((c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p?.text || '').join('') : ''))
                .filter(Boolean)
                .join('\n');
            }
          } else {
            const translated = chatToResponses(body);
            prompt = translated.input.map((i) => i.content).join('\n');
            instructions = translated.instructions || instructions;
          }
          if (!prompt) return sendJson(res, 400, { error: { message: 'No input text found in request', type: 'invalid_request_error', code: null } });

          const result = await runInference({ model, prompt, instructions });
          lastRun.inference = { ...result, model, prompt };

          if (!result.ok) {
            const described = fromInferenceResult(result);
            buildPocResult();
            return sendJson(res, described.httpStatus || 502, errorPayload(described));
          }

          if (body.stream) {
            return sendSse(res, route === '/v1/responses' ? responsesSseFrames(result, model) : chatSseChunks(result, model));
          }
          buildPocResult();
          return sendJson(res, 200, route === '/v1/responses' ? toResponsesObject(result, model) : toChatCompletion(result, model));
        }

        return sendJson(res, 404, { error: { message: `Unknown endpoint: ${route}`, type: 'invalid_request_error', code: null } });
        } catch (err) {
          const described = describeError({
            httpStatus: err.httpStatus ?? null,
            code: err.errorType ?? null,
            message: err.message,
            stage: 'local',
          });
          return sendJson(res, described.httpStatus || 500, errorPayload(described));
        }
      }

      /* ----- 本地控制台 ----- */
      if (route === '/') return sendHtml(res, 200, renderPage());
      if (route === '/favicon.ico') return res.writeHead(204).end();

      if (route === '/auth/callback') {
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

      if (route === '/api/state') {
        const summary = connectionSummary();
        return sendJson(res, 200, {
          ...summary,
          pending: getPending(),
          redirectUri,
          scopesRequested: SCOPES,
          resource: RESOURCE,
          dynamicClientId: DYNAMIC_CLIENT_ID,
          appName: APP_NAME,
          apiKeyUnset: true,
          storage: storageInfo(),
        });
      }

      if (route === '/api/login' && req.method === 'POST') {
        try {
          const flow = await startAuthorization({ redirectUri });
          lastRun.oauth = { mode: flow.mode, clientIdUsed: flow.clientIdUsed };
          return sendJson(res, 200, flow);
        } catch (err) {
          return sendJson(res, 200, { error: err.message });
        }
      }

      if (route === '/api/logout' && req.method === 'POST') {
        cancelPending();
        clearCredentials();
        lastRun.models = null;
        lastRun.inference = null;
        buildPocResult();
        return sendJson(res, 200, { ok: true });
      }

      if (route === '/api/models' && req.method === 'POST') {
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

      if (route === '/api/infer' && req.method === 'POST') {
        const body = parseJson(await readBody(req));
        const model = body.model;
        if (!model) return sendJson(res, 400, { error: '缺少 model' });
        const prompt = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt : TEST_PROMPT;
        const outcome = await runInference({ model, prompt });
        lastRun.inference = { ...outcome, model, prompt };
        buildPocResult();
        return sendJson(res, 200, { ...outcome, model, prompt });
      }

      if (route === '/api/evidence') {
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
          storage: storageInfo(),
          connection: { connected: summary.connected, clientId: summary.clientId, hostId: summary.hostId, scopes: summary.scopes },
        });
      }

      if (route === '/api/poc-result') {
        return sendJson(res, 200, readLog('poc-result.json') || buildPocResult());
      }

      return sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  });

  server.listen(port, host, () => {
    const loopbackOnly = host === '127.0.0.1' || host === '::1';
    console.log(`manus-codex-bridge listening on ${host}:${port}`);
    console.log(`  console    : http://127.0.0.1:${port}/`);
    console.log(`  OpenAI API : http://127.0.0.1:${port}/v1  (models, responses, chat/completions)`);
    console.log(`  redirect   : ${redirectUri}`);
    console.log(`  storage    : ${storageInfo().label}`);
    console.log(`  local key  : ${apiKey ? 'required' : 'not required'}`);
    if (!loopbackOnly) {
      console.log('  reachable from this network:');
      for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
        for (const a of addrs || []) {
          if (a.family === 'IPv4' && !a.internal) {
            console.log(`    http://${a.address}:${port}/   (${name})`);
          }
        }
      }
      console.log('  ⚠️  Bound beyond loopback — any device on this network can reach it.');
      console.log('      /v1/* requires the local API key. Sign-in still happens on THIS machine,');
      console.log(`      because the OAuth callback must be ${redirectUri}.`);
    }
  });

  return server;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const server = startHttpServer({ port: DEFAULT_PORT, apiKey: process.env.MCB_API_KEY || null });
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
}
