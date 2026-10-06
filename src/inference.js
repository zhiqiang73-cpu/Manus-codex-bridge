import { getAccessToken } from './oauth.js';
import { writeLog } from './store.js';

/**
 * 官方文档要求：
 *  - 模型目录：GET https://api.openai.com/v1/models （Bearer = OAuth access token）
 *  - 推理：POST https://api.openai.com/v1/responses，必须 store:false 且 stream:true
 * 文档：https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
 */

export const MODELS_ENDPOINT = 'https://api.openai.com/v1/models';
export const RESPONSES_ENDPOINT = 'https://api.openai.com/v1/responses';

/** 拉取模型目录；返回原始响应与用于下拉框的列表（不硬编码任何模型） */
export async function listModels() {
  const token = await getAccessToken();
  const res = await fetch(MODELS_ENDPOINT, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  if (!res.ok) {
    const err = new Error(`模型目录请求失败 (${res.status})`);
    err.step = 'models';
    err.httpStatus = res.status;
    err.errorType = body?.error?.type || body?.error?.code || null;
    err.errorMessage = body?.error?.message || text.slice(0, 400);
    throw err;
  }

  const raw = Array.isArray(body?.models) ? body.models : Array.isArray(body?.data) ? body.data : [];
  const visible = raw.filter((m) => (m.visibility ? m.visibility === 'list' : true));
  const models = visible.map((m) => ({
    id: m.slug || m.id,
    display_name: m.display_name || m.displayName || m.slug || m.id,
    visibility: m.visibility ?? null,
    raw_keys: Object.keys(m).slice(0, 40),
  }));

  // logs/models.json —— 不含任何凭据
  writeLog('models.json', {
    at: new Date().toISOString(),
    endpoint: MODELS_ENDPOINT,
    http_status: res.status,
    response_shape: Array.isArray(body?.models) ? 'models[]' : Array.isArray(body?.data) ? 'data[]' : 'unknown',
    total_returned: raw.length,
    visible_count: models.length,
    models,
    // 完整模型 ID 列表已在 models[] 中；这里只保留结构摘要，避免把巨大的模型提示词模板写进日志
    raw_response_summary: {
      top_level_keys: Object.keys(body || {}),
      per_model_keys: raw[0] ? Object.keys(raw[0]) : [],
      hidden_count: raw.length - visible.length,
    },
  });

  return { models, rawCount: raw.length, body };
}

/**
 * 一次流式推理。只有收到 response.completed 才算成功。
 */
export async function runInference({ model, prompt, instructions }) {
  const token = await getAccessToken();
  const requestBody = {
    model,
    input: [{ role: 'user', content: prompt }],
    store: false,
    stream: true,
  };
  if (instructions) requestBody.instructions = instructions;

  const started = Date.now();
  const res = await fetch(RESPONSES_ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body: JSON.stringify(requestBody),
  });

  const contentType = res.headers.get('content-type') || '';

  // 注意：官方流式响应实测 **不带 content-type 头**（返回 null），
  // 因此这里不能靠 content-type 判断，只能靠 HTTP 状态 + 实际解析事件。
  if (!res.ok) {
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* 非 JSON */
    }
    return {
      ok: false,
      endpoint: RESPONSES_ENDPOINT,
      requestBody,
      httpStatus: res.status,
      contentType,
      errorType: body?.error?.type || body?.error?.code || null,
      errorMessage: body?.error?.message || text.slice(0, 600),
      text: '',
      completed: false,
      durationMs: Date.now() - started,
      events: [],
    };
  }

  const events = [];
  const seen = new Map();
  let text = '';
  let completed = false;
  let failed = null;
  let usage = null;
  let responseId = null;
  let rawAll = '';

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const piece = decoder.decode(value, { stream: true });
    rawAll += piece;
    buffer += piece;
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of chunk.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let event;
        try {
          event = JSON.parse(payload);
        } catch {
          continue;
        }
        const type = event.type || 'unknown';
        seen.set(type, (seen.get(type) || 0) + 1);
        events.push(type);

        if (type === 'response.created' && event.response?.id) responseId = event.response.id;
        if (type === 'response.output_text.delta') text += event.delta || '';
        if (type === 'response.completed') {
          completed = true;
          usage = event.response?.usage || null;
          responseId = event.response?.id || responseId;
        }
        if (type === 'response.failed') {
          failed = {
            code: event.response?.error?.code || 'unknown_error',
            message: event.response?.error?.message || null,
          };
        }
        if (type === 'response.incomplete') {
          failed = { code: 'response_incomplete', message: event.response?.incomplete_details?.reason || null };
        }
      }
    }
  }

  // 兜底：完全没解析到 Responses 事件时，尝试按 JSON 解析（服务端未走 SSE 的情况）
  if (events.length === 0 && rawAll.trim()) {
    try {
      const parsed = JSON.parse(rawAll);
      if (typeof parsed?.output_text === 'string') text = parsed.output_text;
      if (parsed?.usage) usage = parsed.usage;
      if (parsed?.id) responseId = parsed.id;
      completed = parsed?.status === 'completed';
      if (parsed?.error) failed = { code: parsed.error.code || 'error', message: parsed.error.message || null };
    } catch {
      failed = { code: 'unparsable_response', message: rawAll.slice(0, 300) };
    }
  }

  return {
    ok: completed && !failed,
    endpoint: RESPONSES_ENDPOINT,
    requestBody,
    httpStatus: res.status,
    contentType,
    text,
    completed,
    failed,
    usage,
    responseId,
    durationMs: Date.now() - started,
    eventCounts: Object.fromEntries(seen),
    errorType: failed?.code || null,
    errorMessage: failed?.message || null,
  };
}
