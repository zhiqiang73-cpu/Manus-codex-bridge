# 跨电脑部署 与 开源发布方案

---

## 一、先纠正一个前提：开源是**明确允许**的

你担心「不能开源放 GitHub」—— 这个担心方向错了。官方帮助中心的原文是：

> **All users can connect their account with supported open source tools.** If you are a Plus or Pro user, you can also connect your ChatGPT account with eligible commercial tools.

而且 OpenAI 官方维护的目录里**专门有一类就叫 "open-source integrations"**：
<https://learn.chatgpt.com/docs/sign-in-with-chatgpt>

### 允许 / 不允许 的真实边界

| 你要做的事 | 是否允许 | 依据 |
| --- | --- | --- |
| 开源放 GitHub | ✅ 允许 | 官方原文明确支持 open source tools |
| 每个人用自己的 ChatGPT 账号登录 | ✅ 允许（这正是设计意图） | 官方目录收录开源集成 |
| 免费、本地运行、不收费 | ✅ 允许 | 同上 |
| **收费订阅 / 卖授权** | ❌ 需要申请 | 「commercial partner…complete this interest form」 |
| **做成网站让别人连你的服务器用** | ❌ 需要申请 | 远程托管属于商业服务形态 |
| **直接抄官方 devkit 的代码** | ❌ 非商业许可 | DevKit Noncommercial License v1.0 |

**关键点：我们这套是照着公开文档自己实现的，没有拷贝 devkit 代码**，所以不受那个非商业许可证约束。你唯一要守住的是「免费 + 本地 + 别人用自己的账号」。

> 一句话：**开源没问题，收费和托管才有问题。**

---

## 二、跨电脑部署：怎么做

### 一个先天优势：这个 PoC 是**零依赖**的

`package.json` 里**没有任何 dependencies**，纯 Node ESM。这意味着：

```bash
git clone <repo> && cd <repo> && node src/server.js
```

**对方机器只要有 Node 18+，不需要 `npm install`，不需要编译，直接能跑。** 这比多数同类项目（Go 要编译、Python 要建虚拟环境）在分发上省事得多。

### 要真正「产品化」到别人的电脑，需要补三块平台适配

| 能力 | macOS | Windows | Linux |
| --- | --- | --- | --- |
| **开机自启** | `~/Library/LaunchAgents/*.plist`（你现有 bridge 已有） | 启动文件夹快捷方式 或 任务计划程序 | `systemd --user` unit |
| **凭据安全存储** | Keychain（`security` 命令） | Credential Manager（`cmdkey`） | libsecret（`secret-tool`） |
| **安装脚本** | `install.sh` | `install.ps1` | `install.sh` |

**第一块你已经有了**（bridge 的 LaunchAgent 那套），**第二块是能不能开源的分水岭** —— 见第四节。

### 分发形态怎么选

| 形态 | 用户需要什么 | 适用 | 建议 |
| --- | --- | --- | --- |
| **A. 源码 + Node** | Node 18+ | 开发者 | ⭐ **先做这个**，零依赖，成本最低 |
| **B. 单文件可执行** | 什么都不用装 | 普通用户 | 用 Node SEA 或 Bun compile 打包，后续再做 |
| **C. npm 全局包** | Node + npm | 开发者 | `npm i -g <pkg>`，比 A 体面一点 |
| **D. Docker** | Docker | 服务器 | ⚠️ **不推荐做主力** —— 容器访问不了宿主钥匙串，浏览器回调也麻烦 |

### 登录环节的跨机约束（很重要）

1. **回调必须是本机回环地址**：官方要求 `http://127.0.0.1:<port>/auth/callback`，不能用 `localhost`，也不能是远程域名。
2. **每台机器有独立的 host id**：官方原文 —— *"Each installation gets its own host ID."* 我们已实现（`state/chatgpt-host.json`，`urn:uuid:...`）。
3. **每台机器要各自授权一次**：官方原文 —— *"Separate registrations stay separate even when their email addresses match."* 也就是同一个 ChatGPT 账号在 A 电脑和 B 电脑上是两条独立注册，各自有独立的 `oaiapp_*` client id。**这是设计如此，不是缺陷。**
4. **凭据不能跨机器拷贝**：拷过去能用（同一账号），但会破坏「每机独立注册」的模型，且增加泄漏面。正确做法是在新机器上重新登录一次。

### ⚠️ 因此：不能做成「远程服务器 + 大家连过来」

技术上不行（回环回调 + 浏览器在本机），条款上也不行（托管=商业服务）。**这个产品天然就是「本地优先」的。**

---

## 三、上传 GitHub：可以，环境已就绪

### 你的环境

| 项 | 状态 |
| --- | --- |
| `gh` CLI | ✅ 2.93.0 已安装 |
| GitHub 登录 | ✅ 已登录（token 含 `repo` + `workflow` 权限） |
| git 身份 | ✅ 已配置 |
| 当前目录 | ⚠️ **不是 git 仓库**，需要 `git init` |

### 发布前敏感信息审计（已跑，结果如下）

| 检查项 | 结果 |
| --- | --- |
| 源码中硬编码密钥 / JWT | ✅ **无** |
| 会被提交的文件 | ✅ 12 个，全是源码与文档 |
| `state/credentials.json`（含你的真实令牌） | ✅ 已被 `.gitignore` 排除 |
| `logs/*.json`（含你的邮箱、subject id） | ✅ 已被 `.gitignore` 排除 |
| `codex-flex-bridge` | ⚠️ **没有 `.gitignore`**，若要发布它必须先补 |

> **首次 `git add` 之前务必再跑一次 `git status`，确认 `state/` 和 `logs/` 不在待提交列表里。**
> 一旦令牌进了公开仓库的 git 历史，即使后来删除也仍然可被翻出来，只能作废令牌。

### 建议的仓库结构

```
chatgpt-plan-bridge/                 # 或你想用的名字
├── LICENSE                          # Apache-2.0（含专利授权，适合这类工具）
├── README.md                        # 是什么 / 为什么合规 / 怎么装 / 怎么用
├── SECURITY.md                      # 凭据如何存储、如何报告漏洞
├── CONTRIBUTING.md
├── .gitignore                       # state/ logs/ node_modules/
├── package.json                     # 零依赖
├── src/
│   ├── oauth.js                     # 官方 dynamic_agent_client 注册 + PKCE
│   ├── inference.js                 # /v1/models + /v1/responses
│   ├── store.js                     # 凭据存储（→ 改造成 OS 钥匙串）
│   ├── server.js / page.js          # 本地控制台
│   └── outbound.js                  # 出站取证
├── scripts/
│   ├── install.sh / uninstall.sh
│   └── test-models.mjs
└── docs/
```

### README 里必须写清楚的三件事（合规要求）

1. 明确写「**非官方项目**，OpenAI 未背书」；用官方 `Continue with ChatGPT` 素材并遵守 [品牌规范](https://openai.com/brand/)
2. 明确写「**仅限开源与本地个人使用**；收费或托管服务请走 [官方合作申请](https://openai.com/form/sign-in-with-chatgpt-interest/)」
3. 明确写「不提供 API Key 访问权限，不代表用户会话，使用者需自备 ChatGPT Plus/Pro 套餐」

---

## 四、最关键的风险：凭据存储

如果只做「自己电脑上用」，明文 `0600` 文件够用。
**如果要开源给别人用，必须换成系统钥匙串** —— 否则你在替陌生人保管他们的 ChatGPT 账号令牌，一旦泄漏，责任在你。

官方 devkit 专门写了 [security.md](https://github.com/openai/sign-in-with-chatgpt-devkit/blob/main/docs/security.md) 讲 OS 加密存储，就是因为它重要。

**这是 P0 和 P1 的分界线：**
- P0（自用）：明文 0600 即可
- P1（开源）：必须上钥匙串 + `SECURITY.md` + 明确的泄漏响应流程

---

## 五、建议的推进顺序

```
1. git init + 补 LICENSE/README/SECURITY/.gitignore     ← 现在就能做
2. 首次 commit（提交前 git status 复核，确认无凭据）
3. 建 GitHub 仓库（先 private，确认没问题再转 public）
4. 常驻化：LaunchAgent + MCP + CLI 开关（P0）
5. 凭据进钥匙串 + 多账号 profile + 完整错误码映射（P1，开源前必须完成）
6. 转 public + 申请进官方目录（P4）
```

**建议先建 private 仓库**，把第 4、5 步做完再公开 —— 这样既拿到了版本管理的好处，又不会把半成品和潜在安全问题暴露出去。
