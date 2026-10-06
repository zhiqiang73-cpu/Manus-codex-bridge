import fs from 'node:fs';
import path from 'node:path';

/**
 * 出站请求取证：包装全局 fetch，记录每一个请求的 method / origin+path / status。
 * 只记录 URL 的 origin + pathname，绝不记录 query（可能含 code）、请求头或请求体。
 */
const records = [];
let logFile = null;
let installed = false;

export function installFetchRecorder(logsDir) {
  if (installed) return;
  installed = true;
  logFile = path.join(logsDir, 'outbound.json');

  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    let url;
    try {
      url = typeof input === 'string' ? input : input?.url || String(input);
      const u = new URL(url);
      const record = {
        at: new Date().toISOString(),
        method: (init?.method || 'GET').toUpperCase(),
        endpoint: `${u.origin}${u.pathname}`,
        status: null,
      };
      records.push(record);
      try {
        const res = await original(input, init);
        record.status = res.status;
        persist();
        return res;
      } catch (err) {
        record.status = `ERROR:${err.name || err.message}`;
        persist();
        throw err;
      }
    } catch (err) {
      if (err instanceof TypeError && /Invalid URL/.test(err.message)) {
        return original(input, init);
      }
      throw err;
    }
  };
}

function persist() {
  if (!logFile) return;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, JSON.stringify(records, null, 2));
  } catch {
    /* 取证失败不影响主流程 */
  }
}

export function getOutboundRecords() {
  return records.map((r) => ({ ...r }));
}

export function calledChatGptBackendApi() {
  return records.some((r) => r.endpoint.includes('chatgpt.com/backend-api'));
}

export function calledCodexEndpoints() {
  return records.filter((r) => /backend-api\/codex|\/codex\//.test(r.endpoint)).map((r) => r.endpoint);
}

export function distinctEndpoints() {
  return [...new Set(records.map((r) => `${r.method} ${r.endpoint}`))];
}
