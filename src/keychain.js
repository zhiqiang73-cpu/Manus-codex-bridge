import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 跨平台凭据存储。
 *
 * 优先级：
 *   macOS   → Keychain（security 命令）
 *   Linux   → Secret Service（secret-tool）
 *   Windows → DPAPI（PowerShell，用户作用域加密）
 *   兜底    → 0600 文件（并明确警告）
 *
 * 无任何第三方依赖，全部通过系统自带命令实现。
 */

const SERVICE = 'manus-codex-bridge';
const ACCOUNT = 'default';

function tryExec(cmd, args, input) {
  try {
    const out = execFileSync(cmd, args, {
      input,
      encoding: 'utf8',
      stdio: input ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout: out };
  } catch (err) {
    return { ok: false, error: err.message, code: err.status ?? null, stderr: String(err.stderr || '') };
  }
}

function hasCommand(cmd) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return tryExec(probe, [cmd]).ok;
}

export function backendName() {
  if (process.platform === 'darwin' && hasCommand('security')) return 'macos-keychain';
  if (process.platform === 'linux' && hasCommand('secret-tool')) return 'linux-secret-service';
  if (process.platform === 'win32' && hasCommand('powershell')) return 'windows-dpapi';
  return 'file-fallback';
}

export function isSecure() {
  return backendName() !== 'file-fallback';
}

/* ---------------- macOS Keychain ---------------- */

function macGet() {
  const r = tryExec('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w']);
  return r.ok ? r.stdout.trim() : null;
}

function macSet(value) {
  tryExec('security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT]);
  const r = tryExec('security', ['add-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w', value, '-U']);
  return r.ok;
}

function macDelete() {
  tryExec('security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT]);
}

/* ---------------- Linux Secret Service ---------------- */

function linuxGet() {
  const r = tryExec('secret-tool', ['lookup', 'service', SERVICE, 'account', ACCOUNT]);
  return r.ok && r.stdout.trim() ? r.stdout.trim() : null;
}

function linuxSet(value) {
  const r = tryExec('secret-tool', ['store', '--label', SERVICE, 'service', SERVICE, 'account', ACCOUNT], value);
  return r.ok;
}

function linuxDelete() {
  tryExec('secret-tool', ['clear', 'service', SERVICE, 'account', ACCOUNT]);
}

/* ---------------- Windows DPAPI ---------------- */

const PS_ENCRYPT = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security;
$plain=[Console]::In.ReadToEnd();
$bytes=[Text.Encoding]::UTF8.GetBytes($plain);
$enc=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,'CurrentUser');
[Console]::Out.Write([Convert]::ToBase64String($enc))`;

const PS_DECRYPT = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security;
$b64=[Console]::In.ReadToEnd().Trim();
if(-not $b64){exit 1}
$enc=[Convert]::FromBase64String($b64);
$dec=[Security.Cryptography.ProtectedData]::Unprotect($enc,$null,'CurrentUser');
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($dec))`;

function dpapiFile() {
  return path.join(process.env.APPDATA || os.homedir(), SERVICE, 'credentials.dpapi');
}

function winGet() {
  const file = dpapiFile();
  if (!fs.existsSync(file)) return null;
  const r = tryExec('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS_DECRYPT], fs.readFileSync(file, 'utf8'));
  return r.ok ? r.stdout.trim() : null;
}

function winSet(value) {
  const r = tryExec('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS_ENCRYPT], value);
  if (!r.ok) return false;
  const file = dpapiFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, r.stdout.trim(), { mode: 0o600 });
  return true;
}

function winDelete() {
  try {
    fs.rmSync(dpapiFile(), { force: true });
  } catch {
    /* 忽略 */
  }
}

/* ---------------- 兜底：0600 文件 ---------------- */

function filePath() {
  return path.join(os.homedir(), '.config', SERVICE, 'credentials.json');
}

function fileGet() {
  try {
    return fs.readFileSync(filePath(), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function fileSet(value) {
  const file = filePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* 忽略 */
  }
  return true;
}

function fileDelete() {
  try {
    fs.rmSync(filePath(), { force: true });
  } catch {
    /* 忽略 */
  }
}

/* ---------------- 对外接口 ---------------- */

export function getSecret() {
  const primary = primaryGet();
  return primary || fileGet();
}

function primaryGet() {
  switch (backendName()) {
    case 'macos-keychain':
      return macGet();
    case 'linux-secret-service':
      return linuxGet();
    case 'windows-dpapi':
      return winGet();
    default:
      return null;
  }
}

/**
 * 写入凭据。
 *
 * 关键：系统钥匙串不可用时（例如受限的执行会话、无 GUI 的容器、缺少 libsecret），
 * 必须**安全回退到 0600 文件**，绝不能因为写入失败就丢掉凭据。
 *
 * @returns {{ok:boolean, backend:string, fellBackFrom?:string, error?:string}}
 */
export function setSecret(value) {
  const primary = backendName();
  let ok = false;
  let error = null;

  try {
    switch (primary) {
      case 'macos-keychain':
        ok = macSet(value);
        break;
      case 'linux-secret-service':
        ok = linuxSet(value);
        break;
      case 'windows-dpapi':
        ok = winSet(value);
        break;
      default:
        ok = false;
    }
  } catch (err) {
    ok = false;
    error = err.message;
  }

  if (ok) return { ok: true, backend: primary };

  let fell = false;
  let fellError = null;
  try {
    fell = fileSet(value);
  } catch (err) {
    fell = false;
    fellError = err.message;
  }

  return {
    ok: fell,
    backend: 'file-fallback',
    fellBackFrom: primary === 'file-fallback' ? undefined : primary,
    error:
      [error, fellError].filter(Boolean).join('; ') ||
      (primary === 'file-fallback' ? undefined : `${primary} 写入被拒绝`),
  };
}

export function deleteSecret() {
  macDelete();
  linuxDelete();
  winDelete();
  fileDelete();
}

/** 当前凭据实际存放的后端（考虑回退） */
export function effectiveBackend() {
  if (primaryGet()) return backendName();
  if (fileGet()) return 'file-fallback';
  return backendName();
}

export function describe() {
  const backend = effectiveBackend();
  const primary = backendName();
  const map = {
    'macos-keychain': 'macOS Keychain',
    'linux-secret-service': 'Linux Secret Service (libsecret)',
    'windows-dpapi': 'Windows DPAPI (current user)',
    'file-fallback': `plain 0600 file at ${filePath()}`,
  };
  const secure = backend !== 'file-fallback';
  return {
    backend,
    label: map[backend],
    secure,
    primaryBackend: primary,
    fellBack: primary !== 'file-fallback' && backend === 'file-fallback',
    filePath: filePath(),
  };
}
