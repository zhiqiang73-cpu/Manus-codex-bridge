import { connectionSummary } from './oauth.js';
import { listModels, runInference } from './inference.js';
import { fromInferenceResult } from './errors.js';
import { storageInfo } from './store.js';

/**
 * MCP stdio 服务（JSON-RPC 2.0，按行分隔）。
 *
 * 重要：stdout 只能输出协议消息，任何日志必须走 stderr。
 * 零依赖实现，供 Manus / Claude Desktop / Cursor 等 MCP 客户端按需拉起。
 */

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'chatgpt-plan-bridge', version: '0.1.0' };

const TOOLS = [
  {
    name: 'chatgpt_status',
    description:
      'Check the local ChatGPT plan connection: whether an account is signed in, whether ChatGPT plan usage was granted, the credential storage backend, and the OAuth scopes. Call this first if another ChatGPT tool returns a not-connected or unauthorized error.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'chatgpt_models',
    description:
      "List the models the signed-in ChatGPT account can see, fetched live from OpenAI's /v1/models. Returns model ids and display names. Note that a listed model is not guaranteed to be usable with plan usage.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'chatgpt_ask',
    description:
      "Send a single prompt to a model using the user's ChatGPT plan and return the completed text. Use this to delegate a self-contained question or generation task. Requires an explicit model id from chatgpt_models.",
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The user message to send.' },
        model: { type: 'string', description: 'Model id from chatgpt_models, e.g. gpt-5.6-luna.' },
        instructions: { type: 'string', description: 'Optional system-level instructions.' },
      },
      required: ['prompt', 'model'],
      additionalProperties: false,
    },
  },
];

function writeMessage(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function reply(id, result) {
  writeMessage({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message, data) {
  writeMessage({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
}

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

function requireConnection() {
  const summary = connectionSummary();
  if (!summary.connected) {
    throw new Error('尚未连接 ChatGPT。请先在终端运行 `cpb login` 完成官方授权。');
  }
  if (!summary.sharing) {
    throw new Error(
      '已登录，但未授予 ChatGPT plan usage（缺少 chatgpt.tokens.use.direct）。请运行 `cpb login` 重新授权并勾选该权限。',
    );
  }
  return summary;
}

async function callTool(name, args = {}) {
  switch (name) {
    case 'chatgpt_status': {
      const summary = connectionSummary();
      const storage = storageInfo();
      return textResult(
        JSON.stringify(
          {
            connected: summary.connected,
            plan_usage_granted: summary.sharing ?? false,
            email: summary.email ?? null,
            client_id: summary.clientId ?? null,
            host_id: summary.hostId ?? null,
            scopes: summary.scopes ?? [],
            storage_backend: storage.label,
            storage_secure: storage.secure,
          },
          null,
          2,
        ),
      );
    }

    case 'chatgpt_models': {
      requireConnection();
      const { models, rawCount } = await listModels();
      return textResult(
        JSON.stringify({ total_returned: rawCount, visible: models.length, models }, null, 2),
      );
    }

    case 'chatgpt_ask': {
      requireConnection();
      if (!args.prompt) throw new Error('缺少参数 prompt');
      if (!args.model) throw new Error('缺少参数 model（请先用 chatgpt_models 获取）');
      const result = await runInference({
        model: args.model,
        prompt: args.prompt,
        instructions: args.instructions,
      });
      if (!result.ok) {
        const err = fromInferenceResult(result);
        throw new Error(`${err.title}\n${err.message ?? ''}\n→ ${err.action}`);
      }
      return textResult(result.text || '(空响应)');
    }

    default:
      throw new Error(`未知工具：${name}`);
  }
}

export function startMcpServer() {
  let buffer = '';
  process.stdin.setEncoding('utf8');

  process.stdin.on('data', async (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        replyError(null, -32700, 'Parse error');
        continue;
      }
      await handleMessage(msg);
    }
  });

  process.stdin.on('end', () => process.exit(0));
}

async function handleMessage(msg) {
  const { id, method, params } = msg;

  // 通知类消息不需要回复
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized' || method === 'initialized') return;
    return;
  }

  try {
    switch (method) {
      case 'initialize':
        return reply(id, {
          protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        });

      case 'ping':
        return reply(id, {});

      case 'tools/list':
        return reply(id, { tools: TOOLS });

      case 'tools/call': {
        const name = params?.name;
        const args = params?.arguments || {};
        try {
          const result = await callTool(name, args);
          return reply(id, result);
        } catch (err) {
          // 工具级错误按 MCP 约定通过 isError 返回，而不是 JSON-RPC error
          return reply(id, { content: [{ type: 'text', text: err.message }], isError: true });
        }
      }

      case 'resources/list':
        return reply(id, { resources: [] });

      case 'prompts/list':
        return reply(id, { prompts: [] });

      default:
        return replyError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    return replyError(id, -32603, err.message);
  }
}
