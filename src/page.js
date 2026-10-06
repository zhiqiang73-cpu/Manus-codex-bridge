export function renderPage() {
  const script = [
    "const $ = (id) => document.getElementById(id);",
    "const NL = String.fromCharCode(10);",
    "",
    "async function api(p, opt) {",
    "  const r = await fetch(p, opt);",
    "  const t = await r.text();",
    "  try { return JSON.parse(t); } catch { return { raw: t }; }",
    "}",
    "function pill(text, kind) {",
    "  const el = $('statusPill');",
    "  el.textContent = text;",
    "  el.className = 'pill' + (kind ? ' ' + kind : '');",
    "}",
    "function note(msg) { $('loginMsg').textContent = msg || ''; }",
    "",
    "async function refreshState() {",
    "  const s = await api('/api/state');",
    "  if (s.connected) {",
    "    pill('Connected', 'ok');",
    "    $('stStatus').textContent = 'Connected' + (s.sharing ? '（已授予 plan usage）' : '（未授予 plan usage）');",
    "  } else {",
    "    pill('Not connected', 'err');",
    "    $('stStatus').textContent = 'Not connected';",
    "  }",
    "  $('stEmail').textContent = s.email || '—';",
    "  $('stClient').textContent = s.clientId || '—';",
    "  $('stHost').textContent = s.hostId || '—';",
    "  $('stScopes').textContent = (s.scopes && s.scopes.length) ? s.scopes.join(' ') : '—';",
    "  if (s.storage) {",
    "    $('stStorage').textContent = s.storage.label + (s.storage.secure ? '' : '（回退：非系统钥匙串）');",
    "  }",
    "  return s;",
    "}",
    "",
    "$('btnLogin').onclick = async () => {",
    "  $('btnLogin').disabled = true;",
    "  note('正在创建授权请求…');",
    "  let r;",
    "  try {",
    "    r = await api('/api/login', { method: 'POST' });",
    "  } catch (e) {",
    "    note('请求 /api/login 失败：' + e.message);",
    "    $('btnLogin').disabled = false;",
    "    return;",
    "  }",
    "  $('btnLogin').disabled = false;",
    "  if (!r || !r.url) {",
    "    note('无法发起授权：' + ((r && r.error) || '服务端未返回授权地址'));",
    "    return;",
    "  }",
    "  note('正在跳转到 OpenAI 授权页…如果 3 秒后没有跳转，请点下面的直达链接。');",
    "  $('authLink').href = r.url;",
    "  $('authLinkBox').style.display = 'block';",
    "  window.location.href = r.url;",
    "};",
    "",
    "$('btnLogout').onclick = async () => {",
    "  await api('/api/logout', { method: 'POST' });",
    "  await refreshState();",
    "  $('modelSelect').innerHTML = '<option value=\"\">（尚未拉取）</option>';",
    "  $('modelsInfo').textContent = '—';",
    "  $('inferResult').textContent = '—';",
    "  note('已断开。');",
    "};",
    "",
    "$('btnModels').onclick = async () => {",
    "  $('btnModels').disabled = true;",
    "  $('modelsInfo').textContent = '请求中…';",
    "  const r = await api('/api/models', { method: 'POST' });",
    "  $('btnModels').disabled = false;",
    "  if (!r.ok) {",
    "    $('modelsInfo').textContent = 'FAILED' + NL + JSON.stringify(r, null, 2);",
    "    return;",
    "  }",
    "  const sel = $('modelSelect');",
    "  sel.innerHTML = '';",
    "  for (const m of r.models) {",
    "    const o = document.createElement('option');",
    "    o.value = m.id;",
    "    o.textContent = m.id + '  ·  ' + m.display_name;",
    "    sel.appendChild(o);",
    "  }",
    "  const head = ['endpoint: ' + r.endpoint, 'http: ' + r.httpStatus,",
    "    '服务器返回总数: ' + r.rawCount + ' / 可选: ' + r.models.length, ''];",
    "  $('modelsInfo').textContent = head.concat(r.models.map((m) => m.id + '  →  ' + m.display_name)).join(NL);",
    "};",
    "",
    "$('btnInfer').onclick = async () => {",
    "  const model = $('modelSelect').value;",
    "  if (!model) { note('请先 Refresh Models 并选择模型'); return; }",
    "  $('btnInfer').disabled = true;",
    "  $('inferResult').textContent = '推理中…（模型 ' + model + '）';",
    "  const r = await api('/api/infer', {",
    "    method: 'POST',",
    "    headers: { 'content-type': 'application/json' },",
    "    body: JSON.stringify({ model: model, prompt: $('promptInput').value }),",
    "  });",
    "  $('btnInfer').disabled = false;",
    "  const lines = [];",
    "  lines.push('模型: ' + model);",
    "  lines.push('状态: ' + (r.ok ? 'SUCCESS' : 'FAILED'));",
    "  lines.push('');",
    "  lines.push('回复:');",
    "  lines.push(r.text || '(空)');",
    "  lines.push('');",
    "  lines.push('endpoint: ' + r.endpoint);",
    "  lines.push('http: ' + r.httpStatus + '   completed: ' + r.completed + '   用时: ' + ((r.durationMs || 0) / 1000).toFixed(2) + 's');",
    "  if (r.usage) lines.push('usage: ' + JSON.stringify(r.usage));",
    "  if (r.errorType || r.errorMessage) lines.push('error: ' + (r.errorType || '') + ' ' + (r.errorMessage || ''));",
    "  $('inferResult').textContent = lines.join(NL);",
    "};",
    "",
    "$('btnEvidence').onclick = async () => {",
    "  const e = await api('/api/evidence');",
    "  $('evidence').textContent = JSON.stringify(e, null, 2);",
    "};",
    "",
    "$('btnPoc').onclick = async () => {",
    "  const p = await api('/api/poc-result');",
    "  $('pocResult').textContent = JSON.stringify(p, null, 2);",
    "};",
    "",
    "(async () => {",
    "  await refreshState();",
    "  const q = new URLSearchParams(location.search);",
    "  if (q.get('connected')) note('授权成功，已连接。');",
    "  if (q.get('error')) note('授权错误：' + q.get('error'));",
    "})();",
  ].join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>Manus-codex-bridge</title>
<style>
  :root{--bg:#0b0d10;--panel:#14171c;--line:#262b33;--text:#e7e9ee;--muted:#98a1ad;--accent:#5b8cff;--ok:#3ecf8e;--err:#ff6b6b}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:15px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
       -webkit-text-size-adjust:100%}
  .wrap{max-width:820px;margin:0 auto;padding:28px 18px 64px}
  h1{font-size:19px;margin:0 0 4px}
  .sub{color:var(--muted);font-size:12.5px;margin-bottom:20px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:13px}
  .card h2{font-size:13.5px;margin:0 0 12px;font-weight:600}
  button{font:inherit;padding:11px 16px;border-radius:10px;border:1px solid var(--line);background:#1a1e24;color:var(--text);
         cursor:pointer;-webkit-tap-highlight-color:transparent;min-height:44px}
  button:hover{border-color:#3a414c}
  button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
  button:disabled{opacity:.5;cursor:not-allowed}
  select,input[type=text]{font:inherit;padding:10px 11px;border-radius:10px;border:1px solid var(--line);
         background:#0e1116;color:var(--text);width:100%;min-height:44px}
  .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .row > button{flex:0 0 auto}
  .kv{display:grid;grid-template-columns:132px 1fr;gap:6px 12px;font-size:13px}
  .kv dt{color:var(--muted)}
  .kv dd{margin:0;word-break:break-all}
  .pill{display:inline-block;padding:3px 11px;border-radius:999px;font-size:12px;border:1px solid var(--line);background:#1a1e24;color:var(--muted)}
  .pill.ok{color:var(--ok);border-color:rgba(62,207,142,.35);background:rgba(62,207,142,.08)}
  .pill.err{color:var(--err);border-color:rgba(255,107,107,.35);background:rgba(255,107,107,.08)}
  pre{margin:10px 0 0;padding:12px;border-radius:10px;background:#0e1116;border:1px solid var(--line);
      white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;
      font:12.5px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;min-height:56px;max-height:340px;overflow:auto}
  .muted{color:var(--muted);font-size:12.5px}
  #loginMsg{color:var(--muted);font-size:12.5px;margin-top:10px;min-height:18px}
  #authLinkBox{display:none;margin-top:8px}
  a{color:var(--accent)}

  /* 窄屏（手机 / iPad 竖屏） */
  @media (max-width:560px){
    .wrap{padding:20px 14px 56px}
    .card{padding:14px;border-radius:12px}
    .kv{grid-template-columns:1fr;gap:2px 0}
    .kv dt{margin-top:8px;font-size:12px}
    .kv dt:first-child{margin-top:0}
    .row{flex-direction:column;align-items:stretch}
    .row > button{width:100%}
    .row > .pill{align-self:flex-start}
    pre{max-height:260px}
    h1{font-size:18px}
  }
</style>
</head>
<body>
<div class="wrap">
  <h1>Manus-codex-bridge</h1>
  <div class="sub">用你的 ChatGPT 套餐驱动本地工具，走官方链路：Sign in with ChatGPT → api.openai.com/v1/models → api.openai.com/v1/responses。不使用 API Key，不调用 chatgpt.com/backend-api/*。</div>

  <section class="card">
    <h2>1 · 连接</h2>
    <div class="row">
      <button class="primary" id="btnLogin">Continue with ChatGPT</button>
      <button id="btnLogout">断开</button>
      <span class="pill" id="statusPill">Not connected</span>
    </div>
    <div id="loginMsg"></div>
    <div id="authLinkBox" class="muted">直达授权链接：<a id="authLink" href="#" target="_blank" rel="noopener">打开 OpenAI 授权页</a></div>
    <dl class="kv" style="margin-top:14px">
      <dt>状态</dt><dd id="stStatus">Not connected</dd>
      <dt>账号</dt><dd id="stEmail">—</dd>
      <dt>签发 client_id</dt><dd id="stClient">—</dd>
      <dt>host id</dt><dd id="stHost">—</dd>
      <dt>granted scopes</dt><dd id="stScopes">—</dd>
      <dt>凭据存储</dt><dd id="stStorage">—</dd>
    </dl>
  </section>

  <section class="card">
    <h2>2 · 模型（来自服务器真实返回）</h2>
    <div class="row">
      <select id="modelSelect"><option value="">（尚未拉取）</option></select>
      <button id="btnModels">Refresh Models</button>
    </div>
    <pre id="modelsInfo">—</pre>
  </section>

  <section class="card">
    <h2>3 · 推理</h2>
    <input id="promptInput" type="text"
      value="Reply with exactly: MANUS_CODEX_BRIDGE_TEST_OK">
    <div class="row" style="margin-top:10px">
      <button class="primary" id="btnInfer">Test Inference</button>
      <span class="muted">可自行修改提示词</span>
    </div>
    <pre id="inferResult">—</pre>
  </section>

  <section class="card">
    <h2>4 · 出站取证</h2>
    <div class="muted" style="margin-bottom:8px">证明只访问官方端点、未使用 API Key。</div>
    <pre id="evidence">—</pre>
    <div class="row" style="margin-top:10px">
      <button id="btnEvidence">刷新取证</button>
      <button id="btnPoc">查看结果报告</button>
    </div>
    <pre id="pocResult">—</pre>
  </section>
</div>
<script>${script}</script>
</body>
</html>`;
}
