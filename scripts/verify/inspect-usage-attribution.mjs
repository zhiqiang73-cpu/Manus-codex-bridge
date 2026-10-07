#!/usr/bin/env node
/**
 * Dump the full response object and usage.attribution from /v1/responses,
 * to see which accounting structure the request lands in.
 *
 * Run: node scripts/verify/inspect-usage-attribution.mjs [--token-file=<path>]
 */
import { loadAccessToken, parseTokenFileArg } from './_token.mjs';

const token = loadAccessToken(parseTokenFileArg());
const MODEL = process.env.PROBE_MODEL || 'gpt-6-astra';
const line = '─'.repeat(76);

const r = await fetch('https://api.openai.com/v1/responses', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: MODEL,
    input: [{ role: 'user', content: 'Reply exactly: quota probe' }],
    store: false,
    stream: true,
  }),
});

console.log(line);
console.log(`POST /v1/responses  HTTP ${r.status}  model=${MODEL}`);
console.log(line);

const raw = await r.text();
let completed = null;
let text = '';
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
    if (j.type === 'response.completed') completed = j.response;
  }
}

if (!completed) {
  console.log('no response.completed received');
  process.exit(1);
}

console.log('\nTop-level response fields:');
for (const k of Object.keys(completed).sort()) {
  const v = completed[k];
  const t = Array.isArray(v) ? `array(${v.length})` : v && typeof v === 'object' ? 'object' : JSON.stringify(v);
  console.log(`  ${k.padEnd(26)} ${t}`);
}

console.log('\nusage (full):');
console.log(JSON.stringify(completed.usage, null, 2));

console.log('\nSelected fields:');
for (const k of ['access_programs', 'reasoning', 'text', 'tool_usage', 'service_tier', 'safety_identifier']) {
  if (completed[k] !== undefined) console.log(`  ${k} = ${JSON.stringify(completed[k])}`);
}

console.log('\nStreamed text:');
console.log(`  "${text}"`);

console.log('\nKeyword scan:');
const blob = JSON.stringify(completed);
for (const kw of ['codex', 'plan', 'quota', 'credit', 'subscription', 'entitle', 'attribution', 'reset']) {
  const n = (blob.match(new RegExp(kw, 'gi')) || []).length;
  console.log(`  ${kw.padEnd(16)} ${n}`);
}

console.log('\nPaths containing those keywords:');
(function walk(o, p = '') {
  if (o === null || typeof o !== 'object') return;
  for (const [k, v] of Object.entries(o)) {
    const np = p ? `${p}.${k}` : k;
    if (/codex|plan|quota|credit|subscription|entitle|tier|attribution|reset|window/i.test(k)) {
      const val = v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `array(${v.length})` : 'object';
      console.log(`  ${np} = ${val}`);
    }
    walk(v, np);
  }
})(completed);
console.log(line);
