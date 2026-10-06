# 常驻化 + 产品化评估

写给下一步决策用。所有事实均来自本轮实测或官方文档原文，标注了出处。

---

## 一、常驻 + 随时开关：怎么落地

你已经有现成的机制了 —— `codex-flex-bridge` 里的 LaunchAgent + MCP 连接器那一套就是干这个的。**不需要发明新东西，只需要把后端从 Codex 后端换成官方 `api.openai.com/v1/responses`。**

### 目标形态

```
┌─ LaunchAgent（开机/登录自启，KeepAlive 崩溃自愈）─┐
│                                                   │
│  chatgpt-plan-bridge  ──┬─ MCP stdio 服务  ← Manus 随时调用
│                         ├─ HTTP 端点 :18888 ← 其他工具/OpenAI SDK
│                         └─ CLI: start/stop/status/login/logout
│                                                   │
└───────────────┬───────────────────────────────────┘
                │  OAuth access token（存 OS 钥匙串 / 0600 文件）
                ▼
      https://api.openai.com/v1/responses
```

### 随时开关的三层控制

| 层级 | 做法 | 效果 |
| --- | --- | --- |
| 进程级 | `launchctl bootstrap` / `bootout`（或 CLI `start`/`stop`） | 彻底停掉，不占内存 |
| 会话级 | LaunchAgent `KeepAlive=false`，用 `launchctl kickstart -k` 按需拉起 | 用的时候才起 |
| 连接级 | 控制台里「断开」清空凭据，MCP 工具返回未连接 | 保留程序、断开授权 |

Manus 侧「随时可用」靠的是 **MCP 连接器**（本地 stdio），这一点现有 bridge 已经验证可行；「随时关闭」靠 `launchctl bootout` 一行命令。

### 具体工作项

1. 把 PoC 的 `oauth.js` / `inference.js` 接到 bridge 的 MCP 工具面（`codex_ask`、`codex_models` 等改成走官方链路）
2. 保留旧 Codex 后端作为可选 `legacy` 模式（你自己额度用尽时的兜底）
3. 写 `install.sh`：装到 `~/Library/Application Support/…`、生成 plist、注册 MCP 连接器、健康检查
4. 写 `uninstall.sh`：bootout + 删 plist + 摘连接器
5. CLI 加 `status`（显示已连接账号、剩余额度提示、当前模式）

**这一步是纯工程，风险低，随时可以做。**

---

## 二、产品化：先说结论

**方向对，但别做成「又一个 Codex 转 OpenAI 代理」——那个位置已经有人占了，而且占得比你好。真正缺的是「官方套餐连接管理器」，那才是你的位置。**

下面是我认为你必须先知道的四件事。

---

## 三、三条硬约束

### 1. 许可证：官方 devkit 是非商业许可

`openai/sign-in-with-chatgpt-devkit` 的 LICENSE 是 **Sign-in with ChatGPT DevKit Noncommercial License v1.0**（非商业许可）。

- ❌ 不能把它的代码拿去做商业产品
- ✅ 我们这次的实现是**照着公开文档自己写的**，没有拷贝 devkit 代码，所以不受该许可证约束
- ⚠️ 但计划用量的**使用条款**仍然约束你（见下条）

### 2. 条款：开源/本地可以，商业托管要审批

官方帮助中心原文：

> All users can connect their account with **supported open source tools**. If you are a Plus or Pro user, you can also connect your ChatGPT account with eligible commercial tools.

> If you're a commercial partner interested in integrating Sign in with ChatGPT, with or without token sharing, please complete **this interest form**.

所以：

| 形态 | 是否可直接做 |
| --- | --- |
| 开源 + 本地运行 + 非商业 | ✅ 明确允许 |
| 付费订阅 / 远程托管服务 | ❌ 需要走 OpenAI 商务合作申请 |

**结论：这个项目只能是「开源 + 本地 + 免费」。不要试图在上面收费。** 可以接受赞助，但不要做付费版/托管版。

### 3. 安全：你会持有别人的 OAuth 令牌

这是这个项目**最大的工程风险**，也是官方 devkit 花大力气做 OS 加密存储的原因。

- 令牌必须进系统钥匙串（macOS Keychain / Windows Credential Manager / libsecret），不能只放明文文件
- 日志绝不能出现 access / refresh / id token（我们 PoC 里已做到，可复用）
- 不能把端点暴露到公网，只能绑定回环地址

**做错这一条，你会泄漏用户账号。** 这是能不能开源的分水岭。

---

## 四、竞品现状（诚实版）

| 项目 | 做了什么 | 与你的关系 |
| --- | --- | --- |
| [hotchpotch/openai-api-server-via-codex](https://github.com/hotchpotch/openai-api-server-via-codex) | Go 写的 OpenAI 兼容服务，**基于 Codex 登录**（`~/.codex/auth.json`），支持 Responses / Chat Completions / 流式 / 工具 / 图片 / 音频；Apache-2.0，77★，138 commits，uvx / PyPI / Docker / Homebrew 全渠道分发 | **最直接的竞品，且成熟度远高于你的 bridge** |
| [farion1231/cc-switch](https://github.com/farion1231/cc-switch) | 跨平台桌面「全能切换器」，支持 Claude Code / Codex / Gemini CLI / OpenCode / OpenClaw 等十个工具 | 你说的 CCswitch 就是它；它切的是**配置**，不是套餐额度 |
| LoginWithChatGPT / usemysub | 用 Codex 订阅做 OAuth 给第三方应用 | 同赛道早期项目 |
| openai/sign-in-with-chatgpt-devkit | 官方 SDK + React 组件 + Paste Perfect 示例 | 官方亲儿子，但**非商业许可** |

### 但这里有一个关键差异

上面几乎所有非官方项目走的是 **Codex 后端**（`chatgpt.com/backend-api/codex`），它们自己的 README 就写着：

> This is an unofficial compatibility server… uses the Codex HTTP backend associated with your ChatGPT login, **which may change without notice**.

**而你这次验证成功的是官方通道**：官方 OAuth（`dynamic_agent_client` 动态注册）+ 官方 `api.openai.com/v1/responses` + 官方计划的 plan usage 授权。这是第一方支持、文档公开、不会被随手改掉的路径。

**这就是你的差异化立足点。**

---

## 五、我建议的定位

不要做「代理」，做**官方套餐的连接与额度管理器**。理由：官方通道的复杂度恰恰在「管理」上，而不在「转发」上。

具体差异点（都是官方文档里真实存在的复杂度，竞品没覆盖）：

1. **多账号 / 多工作区 profile 管理**
   官方要求：签发 client_id 绑定账号、`id_token_hint` / `login_hint` 用于复登、host id 每台机器唯一、注册彼此独立（即使邮箱相同）。这是一整套状态机。

2. **正确的额度语义**
   官方明确：应用级每周上限是**上限而不是独立额度池**，"The app can reach its limit while you still have ChatGPT usage remaining"。产品必须区分「应用上限」和「套餐总上限」，并直接引导到 `chatgpt.com/settings/usage` —— 而不是像我们第一次那样误判成「模型不可用」。

3. **完整的错误映射表**
   官方给了 10 个结构化错误码（`subscription_sharing_user_not_eligible` 403、`usage_limit_exceeded` 429、`usage_unavailable` 503、`unsupported_capability` 400 …）+ 刷新令牌失效的 6 种错误。多数项目只处理 401/429。把这张表实现完整，就是可靠性差距。

4. **统一出口，任意 harness**
   本地同时提供 **MCP**（给 Manus / Claude Code 等 Agent）+ **OpenAI 兼容 HTTP**（给现有 SDK）。竞品基本只做 HTTP。

5. **「切换」视角**
   回答「我哪个账号 / 哪个工具在吃我的额度」。这是 CCswitch 的形态，但作用于**官方套餐额度**，目前没人做。

一句话：**做 ChatGPT 套餐的本地连接管理器（Connection Manager），而不是又一个代理（Proxy）。**

---

## 六、路线图建议

| 阶段 | 内容 | 风险 |
| --- | --- | --- |
| P0 | 常驻化：LaunchAgent + MCP + CLI 开关，后端切到官方通道 | 低 |
| P1 | 凭据进 OS 钥匙串 + 多 profile + 完整错误映射表 | 中（安全是重点） |
| P2 | OpenAI 兼容 HTTP 端点 + 用量面板（含跳转 settings/usage） | 中 |
| P3 | 开源发布：README / LICENSE(MIT or Apache-2.0) / 品牌合规（用官方 "Continue with ChatGPT" 素材与规范）/ 申请进官方目录 | 低 |
| P4 | 申请进 [Sign in with ChatGPT partners 目录](https://learn.chatgpt.com/docs/sign-in-with-chatgpt)（官方目录含 open-source integrations 分类） | 需官方审核 |

**P0 现在就能做。** P1 是能不能开源的分水岭。

---

## 七、需要你决定的事

1. **做新项目，还是把现有 bridge 改造成官方通道？**
   （bridge 已有 LaunchAgent + MCP + CLI 全套骨架，改造比重写省很多）
2. **要不要保留 Codex 后端作为 legacy 模式？**
   （你现在额度用尽，legacy 是唯一还能用的；但它属于非官方路径，公开项目里要不要带，影响合规形象）
3. **许可证选 MIT 还是 Apache-2.0？**（Apache-2.0 含专利授权，更适合这类工具）
4. **P0 现在就做吗？**

---

## 附：你当前账号的状态

- 套餐：**Plus**（`chatgpt.tokens.use.direct` 已授予）
- 实测：`gpt-5.6-luna` 可用；`gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-6-astra` 返回 `subscription_sharing_usage_limit_exceeded`
- **去 [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage) 看 App limits 和重置时间** —— 官方说「重新登录或反复重试都不会恢复额度」，不要靠猜
- 如果那里有「allow apps to use credits」开关，打开它并把该应用上限设为 100%，才可能在套餐额度用尽后继续用
