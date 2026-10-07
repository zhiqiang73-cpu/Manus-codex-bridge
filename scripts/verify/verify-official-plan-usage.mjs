#!/usr/bin/env node
/**
 * End-to-end verification of the official ChatGPT Plan Usage route.
 *
 *   1. credential gates: aud / scope / lifetime
 *   2. GET  /v1/models
 *   3. POST /v1/responses  (store:false, stream:true, model from /v1/models)
 *   4. require response.completed
 *
 * Run: node scripts/verify/verify-official-plan-usage.mjs [--token-file=<path>]
 */
import crypto from 'node:crypto';
import { loadAccessToken, parseTokenFileArg } from './_token.mjs';

const token = loadAccessToken(parseTokenFileArg());
const RESOURCE = 'https://api.openai.com/v1';
const REQUIRED_SCOPE = 'chatgpt.tokens.use.direct';
const PROMPT = process.env.TEST_PROMPT || 'Reply exactly: OAuth works';
const line = '─'.repeat(76);

const fp = (s) => (s ? crypto.createHash('sha256').update(s).digest('hex').slice(0, 12) : '(none)');

function decodeJwt(t) {
  try {
    return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

const claims = decodeJwt(token) || {};
const scopes = String(claims.scope || '').split(/\s+/).filter(Boolean);
const lifetime = claims.exp && claims.iat ? claims.exp - claims.iat : null;

console.log(line);
console.log('1) Credential gates');
console.log(line);
console.log(`  aud                        ${claims.aud}  ${claims.aud === RESOURCE ? 'OK' : 'FAIL'}`);
console.log(`  scopes                     ${scopes.join(' ')}`);
console.log(`  ${REQUIRED_SCOPE}  ${scopes.includes(REQUIRED_SCOPE) ? 'OK' : 'MISSING'}`);
console.log(`  token lifetime             ${lifetime} s`);
console.log(`  sha256                     ${fp(token)}`);

const gateOk = claims.aud === RESOURCE && scopes.includes(REQUIRED_SCOPE) && lifetime === 3600;
console.log(`  gate result                ${gateOk ? 'PASS' : 'FAIL'}`);
if (!gateOk) process.exit(2);

console.log(`\n${line}\n2) GET ${RESOURCE}/models\n${line}`);
const mr = await fetch(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${token}` } });
const mText = await mr.text();
console.log(`  HTTP ${mr.status}`);
if (!mr.ok) {
  console.log(`  ${mText.slice(0, 400)}`);
  process.exit(3);
}
const mj = JSON.parse(mText);
const models = (mj.models || mj.data || []).map((m) => ({
  slug: m.slug || m.id,
  display_name: m.display_name || m.id,
  visibility: m.visibility || '(n/a)',
}));
const listable = models.filter((m) => m.visibility === 'list');
console.log(`  ${models.length} models, ${listable.length} with visibility=list:`);
for (const m of models) {
  const mark = m.visibility === 'list' ? '*' : '-';
  console.log(`    ${mark} ${String(m.slug).padEnd(26)} ${m.display_name}`);
}
const chosen = (listable[0] || models[0])?.slug;
if (!chosen) process.exit(4);

console.log(`\n${line}\n3) POST ${RESOURCE}/responses\n${line}`);
console.log(`  model (from /v1/models): ${chosen}`);
const r = await fetch(`${RESOURCE}/responses`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: chosen, input: [{ role: 'user', content: PROMPT }], store: false, stream: true }),
});
console.log(`  HTTP ${r.status}`);
if (!r.ok) {
  console.log(`  ${(await r.text()).slice(0, 600)}`);
  process.exit(5);
}

const raw = await r.text();
let text = '';
let completed = false;
let usage = null;
let failure = null;
for (const block of raw.split('\n\n')) {
  for (const l of block.split('\n')) {
    if (!l.startsWith('data:')) continue;
    const p = l.slice(5).trim();
    if (!p || p === '[DONE]') continue;
    let j;
    try {
      j = JSON.parse(p);
    } catch {
      continue;
    }
    if (j.type === 'response.output_text.delta') text += j.delta || '';
    else if (j.type === 'response.completed') {
      completed = true;
      usage = j.response?.usage || null;
      const t = (j.response?.output || []).flatMap((i) => i.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('');
      if (t) text = t;
    } else if (j.type === 'response.failed') failure = j.response?.error || { message: 'failed' };
  }
}

console.log(`\n${line}\n4) Result\n${line}`);
console.log(`  response.completed   ${completed ? 'YES' : 'NO'}`);
if (failure) console.log(`  response.failed      ${failure.code || '?'} ${failure.message || '?'}`);
if (usage) console.log(`  usage                input=${usage.input_tokens} output=${usage.output_tokens} total=${usage.total_tokens}`);
console.log(`  model text           "${text}"`);
console.log(`  matches expectation  ${text.trim() === PROMPT.replace(/^Reply exactly:\s*/i, '').trim() ? 'YES' : 'NO'}`);
console.log(line);
