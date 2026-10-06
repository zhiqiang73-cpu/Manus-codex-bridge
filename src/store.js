import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
export const STATE_DIR = path.join(ROOT, 'state');
export const LOGS_DIR = path.join(ROOT, 'logs');

const HOST_FILE = path.join(STATE_DIR, 'chatgpt-host.json');
const CRED_FILE = path.join(STATE_DIR, 'credentials.json');

function ensureDirs() {
  for (const dir of [STATE_DIR, LOGS_DIR]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* 忽略 */
    }
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value, mode) {
  ensureDirs();
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
  if (mode) {
    try {
      fs.chmodSync(file, mode);
    } catch {
      /* 忽略 */
    }
  }
}

/** 本机 host id：每个安装唯一，形如 urn:uuid:... */
export function getHostId() {
  ensureDirs();
  const existing = readJson(HOST_FILE);
  if (existing?.ext_agent_host_id) return existing.ext_agent_host_id;
  const value = `urn:uuid:${crypto.randomUUID()}`;
  writeJson(HOST_FILE, { ext_agent_host_id: value, created_at: new Date().toISOString() });
  return value;
}

export function loadCredentials() {
  return readJson(CRED_FILE);
}

/** 凭据文件 0600；绝不写入 logs/，绝不打印 */
export function saveCredentials(record) {
  writeJson(CRED_FILE, record, 0o600);
  return record;
}

export function clearCredentials() {
  try {
    fs.rmSync(CRED_FILE, { force: true });
  } catch {
    /* 忽略 */
  }
}

export function hasSharingScope(creds) {
  const scopes = Array.isArray(creds?.scopes) ? creds.scopes : [];
  return scopes.includes('chatgpt.tokens.use.direct');
}

export function writeLog(name, value) {
  ensureDirs();
  writeJson(path.join(LOGS_DIR, name), value);
}

export function readLog(name) {
  return readJson(path.join(LOGS_DIR, name));
}

/** 脱敏：任何对外输出都不允许出现 token */
export function redact(value) {
  const clone = JSON.parse(JSON.stringify(value));
  for (const key of ['access_token', 'refresh_token', 'id_token', 'authorization', 'code']) {
    if (key in clone) clone[key] = '<hidden>';
  }
  return clone;
}
