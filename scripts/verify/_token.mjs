/**
 * Shared access-token loader for the verification scripts.
 *
 * Resolution order:
 *   1. OPENAI_OAUTH_TOKEN environment variable
 *   2. --token-file=<path> / CHATGPT_PLAN_CREDENTIALS (a credentials JSON)
 *   3. ~/.config/chatgpt-plan-relay/credentials.json
 *
 * The token is only ever read, never written, and never printed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function loadAccessToken({ tokenFile } = {}) {
  if (process.env.OPENAI_OAUTH_TOKEN) return process.env.OPENAI_OAUTH_TOKEN;

  const candidates = [
    tokenFile,
    process.env.CHATGPT_PLAN_CREDENTIALS,
    path.join(os.homedir(), '.config', 'chatgpt-plan-relay', 'credentials.json'),
  ].filter(Boolean);

  for (const file of candidates) {
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      const token = json.access_token || json.accessToken;
      if (token) return token;
    } catch {
      /* try the next candidate */
    }
  }

  throw new Error(
    'No access token found. Set OPENAI_OAUTH_TOKEN, or pass --token-file=<credentials.json>.\n' +
      'If you used `mcb login`, export the token with: export OPENAI_OAUTH_TOKEN=$(mcb token)'
  );
}

export function parseTokenFileArg(argv = process.argv.slice(2)) {
  for (const a of argv) {
    if (a.startsWith('--token-file=')) return { tokenFile: a.slice('--token-file='.length) };
  }
  return {};
}
