#!/usr/bin/env node
/**
 * Probe what the official ChatGPT Plan Usage route actually accepts.
 *
 * Findings feed docs/verification/official-route-constraints.md.
 * Run: node scripts/verify/probe-official-constraints.mjs [--token-file=<path>]
 */
import { loadAccessToken, parseTokenFileArg } from './_token.mjs';

const token = loadAccessToken(parseTokenFileArg());
const MODEL = process.env.PROBE_MODEL || 'gpt-6-astra';
const URL_RESPONSES = 'https://api.openai.com/v1/responses';

async function probe(name, body) {
  const r = await fetch(URL_RESPONSES, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();

  let summary;
  if (r.ok) {
    const failed = /"type":"response\.failed"/.test(text);
    const done = /"type":"response\.completed"/.test(text);
    const code = text.match(/"code":"([a-z_]+)"/);
    summary = `200  completed=${done}  failed=${failed}${code ? `  code=${code[1]}` : ''}`;
  } else {
    summary = `${r.status}  ${text.replace(/\s+/g, ' ').slice(0, 200)}`;
  }

  console.log(`\n▶ ${name}\n  ${summary}`);
  return summary;
}

const base = { model: MODEL, store: false, stream: true };

await probe('A. plain text input (baseline)', {
  ...base,
  input: [{ role: 'user', content: 'Reply exactly: ok' }],
});

await probe('B. instructions field', {
  ...base,
  instructions: 'You are terse.',
  input: [{ role: 'user', content: 'Reply exactly: ok' }],
});

await probe('C. top-level system message item', {
  ...base,
  input: [
    { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'You are terse.' }] },
    { role: 'user', content: 'Reply exactly: ok' },
  ],
});

await probe('D. top-level tools, FLAT format', {
  ...base,
  input: [{ role: 'user', content: 'What is the weather in Beijing?' }],
  tools: [
    {
      type: 'function',
      name: 'get_weather',
      description: 'Look up the weather for a city',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      strict: false,
    },
  ],
  tool_choice: 'auto',
});

await probe('E. top-level tools, NESTED function:{} format', {
  ...base,
  input: [{ role: 'user', content: 'What is the weather in Beijing?' }],
  tools: [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Look up the weather for a city',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    },
  ],
  tool_choice: 'auto',
});

await probe('F. unsupported parameter: temperature', {
  ...base,
  temperature: 0.5,
  input: [{ role: 'user', content: 'Reply exactly: ok' }],
});

await probe('G. unsupported parameter: max_output_tokens', {
  ...base,
  max_output_tokens: 64,
  input: [{ role: 'user', content: 'Reply exactly: ok' }],
});
