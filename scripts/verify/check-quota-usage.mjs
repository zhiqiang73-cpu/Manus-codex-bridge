#!/usr/bin/env node
/**
 * Determine which usage bucket the official OAuth token draws from.
 *
 * Evidence collected:
 *   - every response header on POST /v1/responses
 *   - rate-limit / quota style headers, compared across two calls
 *   - the same headers on GET /v1/models for contrast
 *
 * Run: node scripts/verify/check-quota-usage.mjs [--token-file=<path>]
 */
import crypto from 'node:crypto';
import { loadAccessToken, parseTokenFileArg } from './_token.mjs';

const token = loadAccessToken(parseTokenFileArg());
const MODEL = process.env.PROBE_MODEL || 'gpt-6-astra';
const RESOURCE = 'https://api.openai.com/v1';
const line = '─'.repeat(76);

const fp = (s) => (s ? crypto.createHash('sha256').update(s).digest('hex').slice(0, 12) : null);

const QUOTA_HINT = /^(x-ratelimit|x-quota|x-usage|x-codex|x-plan|x-chatgpt|x-request|x-oai|x-organization|x-project|retry-after|openai-|ratelimit)/i;

function quotaHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) if (QUOTA_HINT.test(k)) out[k] = v;
  return out;
}

function headersToObject(h) {
  const out = {};
  h.forEach((v, k) => (out[k] = v));
  return out;
}

function decodeJwt(t) {
  try {
    return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

const claims = decodeJwt(token) || {};

console.log(line);
console.log('Token identity');
console.log(line);
console.log(`  aud     ${claims.aud}`);
console.log(`  scope   ${String(claims.scope || '').split(/\s+/).join(' ')}`);
console.log(`  sha256  ${fp(token)}`);

async function call(label) {
  const r = await fetch(`${RESOURCE}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      input: [{ role: 'user', content: 'Reply exactly: quota probe' }],
      store: false,
      stream: true,
    }),
  });
  const all = headersToObject(r.headers);
  const body = await r.text();
  return {
    label,
    status: r.status,
    all,
    quota: quotaHeaders(all),
    usage: body.match(/"usage":\{[^}]*\}/)?.[0] || null,
    completed: /"type":"response\.completed"/.test(body),
  };
}

console.log(`\n${line}\nCall 1\n${line}`);
const c1 = await call('call-1');
console.log(`  HTTP ${c1.status}  completed=${c1.completed}  ${c1.usage || ''}`);
console.log('\n  all response headers:');
for (const [k, v] of Object.entries(c1.all).sort()) console.log(`    ${k}: ${v}`);

console.log(`\n${line}\nCall 2\n${line}`);
const c2 = await call('call-2');
console.log(`  HTTP ${c2.status}  completed=${c2.completed}`);

console.log(`\n${line}\nQuota / rate-limit headers across calls\n${line}`);
const keys = [...new Set([...Object.keys(c1.quota), ...Object.keys(c2.quota)])].sort();
if (!keys.length) {
  console.log('  none present — this route does not expose standard rate-limit headers');
} else {
  for (const k of keys) {
    console.log(`  ${k}\n    call1: ${String(c1.quota[k] ?? '(none)').slice(0, 90)}\n    call2: ${String(c2.quota[k] ?? '(none)').slice(0, 90)}`);
  }
}

console.log(`\n${line}\nGET /v1/models for contrast\n${line}`);
const mr = await fetch(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${token}` } });
const mq = quotaHeaders(headersToObject(mr.headers));
console.log(`  HTTP ${mr.status}`);
console.log(Object.keys(mq).length ? mq : '  no quota headers');
await mr.text();

console.log(`\n${line}`);
console.log('  See docs/verification/quota-attribution.md for the interpretation.');
console.log(line);
