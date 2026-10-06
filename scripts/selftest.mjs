#!/usr/bin/env node
/**
 * 离线自检：不需要账号、不需要联网。
 * 覆盖错误映射、请求翻译、凭据存储往返、MCP 协议。
 *
 *   node scripts/selftest.mjs
 */
import assert from 'node:assert/strict';

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

console.log('chatgpt-plan-bridge self-test\n');

/* ---------- 错误映射 ---------- */
console.log('error mapping');

const errors = await import('../src/errors.js');

await check('未连接 → 401 not_connected', () => {
  const d = errors.describeError({ code: 'not_connected', message: '尚未连接 ChatGPT' });
  assert.equal(d.httpStatus, 401);
  assert.equal(d.code, 'not_connected');
  assert.ok(d.action.includes('cpb login'));
});

await check('套餐上限 → 429，且不把 200 透传给调用方', () => {
  // 上游在 HTTP 200 的事件流里返回失败，对调用方必须回 429
  const d = errors.describeError({ code: 'subscription_sharing_usage_limit_exceeded', httpStatus: 200 });
  assert.equal(d.httpStatus, 429);
  assert.equal(d.upstreamHttpStatus, 200);
  assert.equal(d.isUsageLimit, true);
  assert.ok(d.action.includes('chatgpt.com/settings/usage'));
});

await check('套餐上限的提示不推断重置时间', () => {
  const d = errors.describeError({ code: 'subscription_sharing_usage_limit_exceeded' });
  assert.ok(/无法判断|不能判断/.test(d.action));
  assert.ok(/重置/.test(d.action));
});

await check('不符合资格 → 403', () => {
  const d = errors.describeError({ code: 'subscription_sharing_user_not_eligible' });
  assert.equal(d.httpStatus, 403);
});

await check('刷新令牌失效被识别', () => {
  const d = errors.describeError({ code: 'invalid_grant' });
  assert.equal(d.title, '刷新令牌已失效');
});

await check('未知错误有兜底且保留原始信息', () => {
  const d = errors.describeError({ code: 'mystery', httpStatus: 418, requestId: 'req_1' });
  assert.equal(d.httpStatus, 418);
  assert.equal(d.requestId, 'req_1');
  assert.equal(d.title, '未识别的错误');
});

await check('formatError 输出含恢复动作', () => {
  const text = errors.formatError(errors.describeError({ code: 'not_connected' }));
  assert.ok(text.includes('401'));
  assert.ok(text.includes('→'));
});

/* ---------- OpenAI 兼容翻译 ---------- */
console.log('\nopenai compatibility');

const compat = await import('../src/openai-compat.js');

await check('chat/completions 的 system 消息映射为 instructions', () => {
  const out = compat.chatToResponses({
    model: 'm',
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ],
  });
  assert.equal(out.instructions, 'be terse');
  assert.equal(out.input.length, 1);
  assert.equal(out.input[0].content, 'hi');
  assert.equal(out.store, false);
  assert.equal(out.stream, true);
});

await check('多段 content 数组被拼接', () => {
  const out = compat.chatToResponses({
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }],
  });
  assert.equal(out.input[0].content, 'ab');
});

await check('toChatCompletion 形状正确', () => {
  const out = compat.toChatCompletion({ ok: true, text: 'hello', usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } }, 'm');
  assert.equal(out.object, 'chat.completion');
  assert.equal(out.choices[0].message.content, 'hello');
  assert.equal(out.choices[0].finish_reason, 'stop');
  assert.equal(out.usage.total_tokens, 5);
});

await check('SSE 分帧以 [DONE] 结束', () => {
  const frames = compat.chatSseChunks({ ok: true, text: 'x' }, 'm');
  assert.ok(frames.at(-1).includes('[DONE]'));
  assert.ok(frames[0].startsWith('data: '));
});

await check('Responses SSE 含 created 与 completed 事件', () => {
  const frames = compat.responsesSseFrames({ ok: true, text: 'x' }, 'm');
  assert.ok(frames[0].includes('response.created'));
  assert.ok(frames.at(-1).includes('response.completed'));
});

await check('错误体为 OpenAI 形状且不重复标题', () => {
  const body = compat.errorPayload({ httpStatus: 401, title: '尚未连接 ChatGPT', message: '尚未连接 ChatGPT', code: 'not_connected' });
  assert.equal(body.error.code, 'not_connected');
  assert.equal(body.error.message, '尚未连接 ChatGPT');
});

/* ---------- 凭据存储 ---------- */
console.log('\ncredential storage');

const keychain = await import('../src/keychain.js');

await check('describe 报告后端与是否回退', () => {
  const d = keychain.describe();
  assert.ok(typeof d.label === 'string' && d.label.length > 0);
  assert.equal(typeof d.secure, 'boolean');
  assert.equal(typeof d.fellBack, 'boolean');
});

await check('写入失败不抛异常，而是返回 ok:false', () => {
  // 在受限环境中系统钥匙串与文件后端都可能不可用
  const res = keychain.setSecret('probe-value');
  assert.equal(typeof res.ok, 'boolean');
  if (!res.ok) {
    assert.ok(typeof res.error === 'string' && res.error.length > 0);
  } else {
    keychain.deleteSecret();
  }
});

/* ---------- MCP 协议 ---------- */
console.log('\nmcp protocol');

const { spawn } = await import('node:child_process');
const { fileURLToPath } = await import('node:url');
const path = await import('node:path');

await check('MCP 握手、工具列表与工具调用', async () => {
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cpb.js');
  const child = spawn(process.execPath, [cli, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });

  const lines = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'selftest', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'chatgpt_status', arguments: {} } },
  ];
  child.stdin.write(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  const out = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('MCP 响应超时'));
    }, 15000);
    child.stdout.on('data', (d) => {
      buf += d;
      if (buf.split('\n').filter(Boolean).length >= 3) {
        clearTimeout(timer);
        child.kill();
        resolve(buf);
      }
    });
    child.on('error', reject);
  });

  const msgs = out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const byId = Object.fromEntries(msgs.map((m) => [m.id, m]));

  assert.equal(byId[1].result.serverInfo.name, 'chatgpt-plan-bridge');
  assert.equal(byId[1].result.protocolVersion, '2024-11-05');

  const toolNames = byId[2].result.tools.map((t) => t.name);
  assert.deepEqual(toolNames, ['chatgpt_status', 'chatgpt_models', 'chatgpt_ask']);

  const status = JSON.parse(byId[3].result.content[0].text);
  assert.equal(typeof status.connected, 'boolean');
  assert.ok('storage_backend' in status);
});

/* ---------- 汇总 ---------- */
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('\nfailed:');
  for (const f of failed) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
console.log('all good');
