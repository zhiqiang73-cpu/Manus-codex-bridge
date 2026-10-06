# PoC 结果：官方 ChatGPT Plan API

## 结果 A

```text
OFFICIAL PLAN API POC: SUCCESS

OAuth: PASS
Models: PASS
Model selection: PASS
Responses API: PASS
OpenAI API Key used: NO
backend-api/codex used: NO

Selected model:
gpt-5.6-luna

Response:
OFFICIAL_CHATGPT_PLAN_TEST_OK
```

测试时间：2026-10-06 12:47–12:51 UTC
未改动、未覆盖任何既有代码（`codex-flex-bridge/` 一行未动）。

---

## 逐步证据

| 步骤 | 结果 | 证据 |
| --- | --- | --- |
| OAuth（动态客户端注册） | PASS | 回调签发正式 `client_id`（形如 `oaiapp_…`）；`ext_agent_host_id` 形如 `urn:uuid:…`；账号邮箱已通过 ID token 验证 |
| 授权范围 | PASS | granted scopes：`chatgpt.tokens.use.direct email offline_access openid profile resource.invoke`（**plan usage 已授予**） |
| ID token 校验 | PASS | signature / issuer / audience / notExpired 四项全部 `true`；nonce 在回调时校验 |
| Models | PASS | `GET https://api.openai.com/v1/models` → HTTP 200，返回 `models[]`，共 7 个，其中 `visibility:"list"` 4 个 |
| 模型人工选择 | PASS | 下拉框内容全部来自服务器返回，未硬编码；本次选 `gpt-5.6-luna` |
| Responses API | PASS | `POST https://api.openai.com/v1/responses` → HTTP 200，`store:false`、`stream:true`，收到 `response.completed` |
| 输出校验 | PASS | `response.output_text` = `OFFICIAL_CHATGPT_PLAN_TEST_OK` |
| 用量 | — | `input_tokens 17 / output_tokens 11 / total_tokens 28` |
| 未使用 API Key | PASS | `OPENAI_API_KEY` 启动时 unset 并忽略；环境内本就不存在 |
| 未调用内部接口 | PASS | 全程出站请求仅 4 条，无任何 `chatgpt.com/backend-api/*` |

### 服务器真实返回的模型（未硬编码）

```
gpt-6-astra    | GPT-6-Astra    | visibility: list
gpt-5.6-sol    | GPT-5.6-Sol    | visibility: list
gpt-5.6-terra  | GPT-5.6-Terra  | visibility: list
gpt-5.6-luna   | GPT-5.6-Luna   | visibility: list
（另有 3 个 visibility 非 list 的条目，按官方文档过滤掉）
```

### 完整出站请求链（`logs/outbound.json`）

```
GET  https://auth.openai.com/.well-known/openid-configuration   200
GET  https://auth.openai.com/.well-known/jwks.json              200
GET  https://api.openai.com/v1/models                           200
POST https://api.openai.com/v1/responses                        200
```

> 注：授权跳转（`https://auth.openai.com/api/accounts/authorize`）与换令牌（`.../oauth/token`）发生在浏览器跳转与服务器端交换中，不在本进程 fetch 记录范围内；它们同样属于 `auth.openai.com` 官方端点。

### 推理请求体（实测）

```json
{
  "model": "gpt-5.6-luna",
  "input": [{ "role": "user", "content": "Reply with exactly: OFFICIAL_CHATGPT_PLAN_TEST_OK" }],
  "store": false,
  "stream": true
}
```

### SSE 事件序列（实测）

```
response.created → response.in_progress → response.output_item.added →
response.content_part.added → response.output_text.delta ×7 →
response.output_text.done → response.content_part.done →
response.output_item.done → response.completed
```

---

## 两个实测踩到的坑（对后续迁移很重要）

1. **流式响应不带 `content-type` 头**。`POST /v1/responses` 返回 200，但 `content-type` 为 `null`（只有 `transfer-encoding: chunked`）。任何依赖 `content-type === text/event-stream` 判断的客户端都会误判为失败 —— 这是本次第一次测试显示 FAILED 的唯一原因。**判定必须靠 HTTP 状态 + 实际解析事件，不能靠 content-type。**
2. **首次注册必须保存回调签发的 `client_id`**。`dynamic_agent_client` 只是注册入口，不是可用于换令牌的客户端 id；下次登录要用签发的 `oaiapp_*`，并省略 `agent_name_hint`。

---

## 合规与适用范围（来自官方文档）

- 官方文档明确：**ChatGPT plan usage 面向开源项目、本地运行的个人项目及部分私有应用**（`https://developers.openai.com/siwc/quickstart`）。
- 付费或远程托管的服务需要先申请候补名单。
- 该通道**不提供**用户 API Key 或会话内容的访问权限，只允许代表用户完成符合条件的 Responses API 请求。

## 凭据存放

| 内容 | 位置 | 权限 |
| --- | --- | --- |
| 凭据（access / refresh / id token） | `state/credentials.json` | `0600` |
| 本机 host id | `state/chatgpt-host.json` | — |
| 日志（模型目录 / 结果 / 出站请求） | `logs/*.json` | 已核验**不含任何令牌** |

## 证据文件

- `logs/poc-result.json` —— 结论与逐步证据
- `logs/oauth-result.json` —— 授权结果与 ID token 校验
- `logs/models.json` —— 服务器真实返回的模型目录
- `logs/outbound.json` —— 出站请求链

---

## 下一步

按约定：**测试成功，到此停止，不继续重构。** 等你下一步指令再决定是否把 `codex-flex-bridge` 迁移到这条官方链路上。

---

# 追加测试：逐模型可用性（`你好吗？`）

测试时间：2026-10-06 12:53–12:54 UTC
提示词：`请原样输出这句话，不要回答它：你好吗？`

## 官方链路（`POST https://api.openai.com/v1/responses`）

| 模型 | 结果 | 回复 / 错误 |
| --- | --- | --- |
| `gpt-5.6-luna` | **OK** | `你好吗？` |
| `gpt-5.6-sol` | FAIL | `subscription_sharing_usage_limit_exceeded` |
| `gpt-5.6-terra` | FAIL | `subscription_sharing_usage_limit_exceeded` |
| `gpt-6-astra` | FAIL | `subscription_sharing_usage_limit_exceeded` |

**结论：当前这个 ChatGPT 套餐的 plan usage 额度只覆盖 `gpt-5.6-luna` 一个模型。**
**实测事实**：`gpt-5.6-luna` 成功，另外三个模型在 `/v1/models` 目录里可见（`visibility:"list"`），但用 OAuth access token 请求时被额度拒绝。

**但不要由此推断「套餐只覆盖 luna 一个模型」** —— 官方文档对 `subscription_sharing_usage_limit_exceeded` 的明确指引是：

> Pause new requests that use the user's ChatGPT plan and link to ChatGPT settings → Usage. **Do not assume the entire plan is empty or infer a reset time from this code alone; an app-specific limit can also apply.**

也就是说，这个错误码可能来自**应用级每周上限**（你在 ChatGPT Settings → Usage 里为该应用设定的百分比上限），也可能是整体额度。正确做法是引导用户去 `https://chatgpt.com/settings/usage` 查看实际剩余量与重置时间，而不是在代码里硬编码「哪些模型可用」。

注意：这个错误是在**流式已经开始之后**才返回的 —— HTTP 状态仍是 **200**，错误通过 SSE 事件 `response.failed`（前置一条 `error` 事件）下发。因此**不能靠 HTTP 状态判断成功**，必须读到 `response.completed`。

错误原文：

```text
The ChatGPT user has reached their Subscription Sharing usage limit.
Ask the user to try again after their usage limit resets or use an API key instead.
```

> 这正是官方文档 [Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery) 里预告的 `subscription_sharing_usage_limit_exceeded`。

## 对照：旧 bridge（`chatgpt.com/backend-api/codex`，Codex 后端 gpt-5.5）

```text
$ codex-bridge ask "请只回复这四个字：你好吗？" --effort low
你好吗？
```

两条链路都能返回中文，但**官方链路是唯一合规、可对外分发的路径**。

## 证据

- `logs/model-availability.json` —— 逐模型测试结果（含错误原文）
- 复现命令：`node scripts/test-models.mjs "你的提示词"`
