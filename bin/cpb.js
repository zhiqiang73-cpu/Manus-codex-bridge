#!/usr/bin/env node
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';

import { connectionSummary, handleCallback, startAuthorization } from '../src/oauth.js';
import { listModels, runInference } from '../src/inference.js';
import { describeError, formatError, fromInferenceResult, USAGE_SETTINGS_URL } from '../src/errors.js';
import { clearCredentials, storageInfo } from '../src/store.js';

const VERSION = '0.1.0';

/* ---------------- 工具 ---------------- */

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const cmdArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}

function freePort(preferred) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(freePort(0)));
    srv.once('listening', () => {
      const p = srv.address().port;
      srv.close(() => resolve(preferred && p === 0 ? preferred : p));
    });
    try {
      srv.listen(preferred ?? 0, '127.0.0.1');
    } catch {
      resolve(0);
    }
  });
}

async function resolvePort(preferred) {
  const port = await freePort(preferred ?? 18888);
  return port || 18888;
}

/* ---------------- 命令 ---------------- */

async function cmdLogin(args) {
  const port = await resolvePort(args.port ? Number(args.port) : undefined);
  const redirectUri = `http://127.0.0.1:${port}/auth/callback`;

  const flow = await startAuthorization({ redirectUri });
  console.log(`授权模式：${flow.mode}`);
  console.log(`回调地址：${redirectUri}`);
  console.log('正在打开浏览器…如果没有自动打开，请手动访问：');
  console.log(`  ${flow.url}\n`);
  openBrowser(flow.url);

  await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (url.pathname.replace(/\/+$/, '') !== '/auth/callback') {
        res.writeHead(404).end();
        return;
      }
      try {
        const outcome = await handleCallback(url.searchParams);
        const storage = storageInfo();
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          `<html><body style="font-family:-apple-system,sans-serif;padding:40px">
           <h2>已连接</h2><p>账号：${outcome.email || '（未返回邮箱）'}</p>
           <p>ChatGPT plan usage：${outcome.sharing ? '已授予' : '未授予'}</p>
           <p>凭据已存入 ${storage.label}</p>
           <p>可以关闭此页面，回到终端继续。</p></body></html>`,
        );
        server.close();
        console.log('授权成功。');
        console.log(`  账号           : ${outcome.email || '（未返回邮箱）'}`);
        console.log(`  client_id      : ${outcome.clientId}`);
        console.log(`  ChatGPT plan   : ${outcome.sharing ? '已授予（可用）' : '未授予 —— 推理会失败，请重新登录并勾选'}`);
        console.log(`  授予的 scopes  : ${outcome.grantedScopes.join(' ')}`);
        console.log(`  ID token 校验  : ${outcome.idTokenVerification?.ok ? '通过' : '未通过（' + (outcome.idTokenVerification?.error || '未知') + '）'}`);
        console.log(`  凭据存储       : ${storage.label}`);
        resolve();
      } catch (err) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<html><body style="font-family:sans-serif;padding:40px"><h2>授权失败</h2><pre>${err.message}</pre></body></html>`);
        server.close();
        reject(err);
      }
    });
    server.listen(port, '127.0.0.1');
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('授权超时（5 分钟）。请重试。'));
    }, 5 * 60 * 1000);
    server.on('close', () => clearTimeout(timer));
  });
}

function cmdLogout() {
  clearCredentials();
  console.log('已断开连接，本地凭据已删除。');
  console.log('注意：若还要撤销 ChatGPT 侧的授权，请到 ChatGPT → Settings → Security and login 断开该应用。');
}

function cmdStatus() {
  const s = connectionSummary();
  const storage = storageInfo();
  console.log('chatgpt-plan-bridge status\n');
  console.log(`  连接状态        : ${s.connected ? 'Connected' : 'Not connected'}`);
  if (s.connected) {
    console.log(`  账号            : ${s.email || '—'}`);
    console.log(`  client_id       : ${s.clientId || '—'}`);
    console.log(`  host_id         : ${s.hostId || '—'}`);
    console.log(`  ChatGPT plan    : ${s.sharing ? '已授予（可用）' : '未授予（推理会失败）'}`);
    console.log(`  授予的 scopes   : ${(s.scopes || []).join(' ') || '—'}`);
    console.log(`  有 refresh token: ${s.hasRefreshToken ? '是' : '否'}`);
    console.log(`  保存时间        : ${s.savedAt || '—'}`);
  }
  console.log(`  凭据存储        : ${storage.label}${storage.secure ? '' : '  ⚠️ 非系统钥匙串，建议安装 libsecret 或使用 macOS/Windows'}`);
  if (!s.connected) console.log('\n运行 `cpb login` 开始。');
}

async function cmdModels() {
  const { models, rawCount } = await listModels();
  console.log(`服务器返回 ${rawCount} 个条目，其中可选 ${models.length} 个：\n`);
  for (const m of models) console.log(`  ${m.id.padEnd(18)} ${m.display_name}`);
  console.log('\n注意：出现在目录里不代表套餐可用。');
}

async function cmdAsk(args) {
  const prompt = args._.slice(1).join(' ') || args.prompt;
  if (!prompt) {
    console.error('用法：cpb ask "你的问题" [--model gpt-5.6-luna] [--instructions "..."]');
    process.exit(1);
  }
  let model = args.model || process.env.CPB_MODEL;
  if (!model) {
    const { models } = await listModels();
    if (!models.length) throw new Error('账号没有可用模型');
    model = models[0].id;
    console.error(`（未指定 --model，使用 ${model}）`);
  }
  const result = await runInference({ model, prompt, instructions: args.instructions });
  if (!result.ok) {
    const described = fromInferenceResult(result);
    console.error(formatError(described));
    process.exit(1);
  }
  process.stdout.write(`${result.text}\n`);
  if (args.verbose) {
    console.error(`\n[model=${model} http=${result.httpStatus} completed=${result.completed}]`);
    if (result.usage) console.error(`[usage] ${JSON.stringify(result.usage)}`);
  }
}

async function cmdServe(args) {
  const { startHttpServer } = await import('../src/server.js');
  const port = Number(args.port || process.env.CPB_PORT || 18888);
  startHttpServer({ port, apiKey: args['api-key'] || process.env.CPB_API_KEY || null });
}

async function cmdMcp() {
  const { startMcpServer } = await import('../src/mcp.js');
  startMcpServer();
}

function cmdHelp() {
  console.log(`chatgpt-plan-bridge v${VERSION}
用你自己的 ChatGPT Plus/Pro 套餐驱动本地工具，走 OpenAI 官方 OAuth 与 Responses API。

用法：cpb <命令> [选项]

命令：
  login              走官方 OAuth 授权（浏览器），把凭据存入系统钥匙串
  logout             删除本地凭据
  status             查看连接状态与凭据存储后端
  models             列出账号可见的模型（实时请求 /v1/models）
  ask "<提示词>"     用套餐跑一次推理
                       --model <id>        指定模型（默认取目录第一个）
                       --instructions <s>  附加系统指令
                       --verbose           额外打印用量
  serve              启动本地 HTTP 服务（控制台 + OpenAI 兼容端点）
                       --port <n>          端口，默认 18888
                       --api-key <k>       为 /v1/* 启用本地 API key 校验
  mcp                以 stdio 启动 MCP 服务，供 Manus / Claude Desktop / Cursor 调用

环境变量：
  CPB_PORT            serve 的默认端口
  CPB_API_KEY         serve 的本地 API key
  CPB_MODEL           ask 的默认模型

说明：
  本工具不使用 OpenAI API Key，也不会自动切换计费方式。
  推理请求只发往 api.openai.com；不会调用 chatgpt.com/backend-api/*。`);
}

/* ---------------- 主入口 ---------------- */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'help';

  try {
    switch (cmd) {
      case 'login':
        return await cmdLogin(args);
      case 'logout':
        return cmdLogout();
      case 'status':
        return cmdStatus();
      case 'models':
        return await cmdModels();
      case 'ask':
        return await cmdAsk(args);
      case 'serve':
        return await cmdServe(args);
      case 'mcp':
        return await cmdMcp();
      case 'version':
      case '--version':
      case '-v':
        console.log(VERSION);
        return;
      case 'help':
      case '--help':
      case '-h':
        return cmdHelp();
      default:
        console.error(`未知命令：${cmd}\n`);
        cmdHelp();
        process.exit(1);
    }
  } catch (err) {
    if (err.httpStatus || err.errorType) {
      console.error(formatError(describeError({ httpStatus: err.httpStatus, code: err.errorType, message: err.errorMessage || err.message })));
    } else {
      console.error(`错误：${err.message}`);
      if (err.step === 'token_exchange' && err.oauthError) console.error(`OAuth：${err.oauthError}`);
    }
    process.exit(1);
  }
}

main();
