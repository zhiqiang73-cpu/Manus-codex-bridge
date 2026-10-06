// 逐个测试服务器返回的模型是否可用（走官方链路），并把结果写入 logs/model-availability.json
// 用法：node scripts/test-models.mjs ["自定义提示词"]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'http://127.0.0.1:18888';
const here = path.dirname(fileURLToPath(import.meta.url));
const LOGS = path.join(here, '..', 'logs');
const prompt = process.argv[2] || '请原样输出这句话，不要回答它：你好吗？';

const modelsRes = await fetch(`${BASE}/api/models`, { method: 'POST' });
const modelsBody = await modelsRes.json();
if (!modelsBody.ok) {
  console.error('拉取模型失败：', JSON.stringify(modelsBody));
  process.exit(1);
}

console.log(`提示词：${prompt}\n`);
const results = [];
for (const m of modelsBody.models) {
  const res = await fetch(`${BASE}/api/infer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: m.id, prompt }),
  });
  const r = await res.json();
  const row = {
    model: m.id,
    display_name: m.display_name,
    ok: r.ok,
    http_status: r.httpStatus,
    completed: r.completed,
    error_type: r.errorType || null,
    error_message: r.errorMessage || null,
    response_text: r.text || '',
    usage: r.usage ? { input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens, total_tokens: r.usage.total_tokens } : null,
  };
  results.push(row);
  const mark = row.ok ? 'OK  ' : 'FAIL';
  console.log(`[${mark}] ${row.model.padEnd(14)} ${row.ok ? JSON.stringify(row.response_text) : row.error_type}`);
}

const summary = {
  at: new Date().toISOString(),
  endpoint: 'https://api.openai.com/v1/responses',
  prompt,
  usable: results.filter((r) => r.ok).map((r) => r.model),
  blocked: results.filter((r) => !r.ok).map((r) => ({ model: r.model, error_type: r.error_type })),
  results,
};
fs.mkdirSync(LOGS, { recursive: true });
fs.writeFileSync(path.join(LOGS, 'model-availability.json'), JSON.stringify(summary, null, 2));

console.log(`\n可用模型：${summary.usable.join(', ') || '（无）'}`);
console.log(`受限模型：${summary.blocked.map((b) => `${b.model}(${b.error_type})`).join(', ') || '（无）'}`);
console.log(`已写入 logs/model-availability.json`);
