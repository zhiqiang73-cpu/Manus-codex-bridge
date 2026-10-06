import { listModels, runInference } from './inference.js';
import { fromInferenceResult } from './errors.js';

/**
 * OpenAI 兼容层。
 *
 * 上游永远走官方 `POST https://api.openai.com/v1/responses`（store:false, stream:true），
 * 这里负责把它翻译成调用方期望的形状：
 *   - /v1/responses        → Responses API 原生形状
 *   - /v1/chat/completions → Chat Completions 形状（含 SSE）
 *
 * 这样任何支持自定义 base_url 的 OpenAI 客户端都能直接指向本服务。
 */

/* ---------------- Chat Completions → Responses ---------------- */

export function chatToResponses(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const systemParts = [];
  const input = [];

  for (const m of messages) {
    const text =
      typeof m?.content === 'string'
        ? m.content
        : Array.isArray(m?.content)
          ? m.content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('')
          : '';
    if (!text) continue;
    if (m.role === 'system' || m.role === 'developer') systemParts.push(text);
    else input.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: text });
  }

  const out = { model: body?.model, input, store: false, stream: true };
  if (systemParts.length) out.instructions = systemParts.join('\n\n');
  return out;
}

/* ---------------- Responses 结果 → 各形状 ---------------- */

function usageOf(result) {
  const u = result?.usage || {};
  return {
    prompt_tokens: u.input_tokens ?? 0,
    completion_tokens: u.output_tokens ?? 0,
    total_tokens: u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
  };
}

export function toChatCompletion(result, model) {
  const created = Math.floor(Date.now() / 1000);
  return {
    id: result.responseId || `chatcmpl_${created}`,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: result.text || '' },
        finish_reason: 'stop',
      },
    ],
    usage: usageOf(result),
  };
}

export function toResponsesObject(result, model) {
  return {
    id: result.responseId || `resp_${Math.floor(Date.now() / 1000)}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: result.completed ? 'completed' : 'failed',
    model,
    output: [
      {
        type: 'message',
        id: `msg_${Math.floor(Date.now() / 1000)}`,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: result.text || '', annotations: [] }],
      },
    ],
    output_text: result.text || '',
    usage: result.usage || null,
    error: result.ok
      ? null
      : { code: result.errorType || 'error', message: result.errorMessage || null },
  };
}

/* ---------------- SSE 输出 ---------------- */

export function chatSseChunks(result, model) {
  const created = Math.floor(Date.now() / 1000);
  const id = result.responseId || `chatcmpl_${created}`;
  const frames = [];

  const frame = (delta, finish = null) =>
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;

  frames.push(frame({ role: 'assistant', content: '' }));
  if (result.text) frames.push(frame({ content: result.text }));
  frames.push(frame({}, 'stop'));
  frames.push('data: [DONE]\n\n');
  return frames;
}

export function responsesSseFrames(result, model) {
  const id = result.responseId || `resp_${Math.floor(Date.now() / 1000)}`;
  const created = Math.floor(Date.now() / 1000);
  const send = (type, payload) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;

  const base = { id, object: 'response', created_at: created, model };
  const frames = [];
  frames.push(send('response.created', { response: { ...base, status: 'in_progress' } }));
  if (result.text) {
    frames.push(
      send('response.output_text.delta', {
        item_id: `msg_${created}`,
        output_index: 0,
        content_index: 0,
        delta: result.text,
      }),
    );
  }
  frames.push(
    send('response.completed', {
      response: {
        ...base,
        status: result.completed ? 'completed' : 'failed',
        output: toResponsesObject(result, model).output,
        usage: result.usage || null,
      },
    }),
  );
  return frames;
}

/* ---------------- 错误形状 ---------------- */

export function errorPayload(err, { openaiShape = true } = {}) {
  const status = err.httpStatus || 500;
  if (!openaiShape) return { detail: err.title || 'error', code: err.code || null };
  const parts = [err.title, err.message].filter(Boolean);
  const unique = parts.filter((p, i) => parts.indexOf(p) === i);
  return {
    error: {
      message: unique.join(' — ') || 'Request failed',
      type: err.code ? 'invalid_request_error' : 'server_error',
      code: err.code || null,
      param: err.param || null,
    },
  };
}

export { listModels, runInference, fromInferenceResult };
