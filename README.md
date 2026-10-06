# ChatGPT Plan Bridge

> **Not affiliated with, endorsed by, or sponsored by OpenAI.** "ChatGPT" and "OpenAI" are trademarks of OpenAI. This is an independent open-source project.

Use the ChatGPT plan you already pay for — **Plus or Pro** — in your own local tools, through OpenAI's **official** sign-in and Responses API. No API key. No per-token billing.

```
Your tool  →  cpb (local)  →  auth.openai.com (OAuth)  →  api.openai.com/v1/responses
                              └─ counts against your ChatGPT plan usage
```

Three ways to use it:

| Surface | For |
| --- | --- |
| **MCP server** (`cpb mcp`) | Manus, Claude Desktop, Cursor, and other MCP clients |
| **OpenAI-compatible HTTP** (`cpb serve`) | Any SDK or tool that accepts a custom `base_url` |
| **CLI** (`cpb ask`) | Shell scripts and quick one-off prompts |

---

## Why this exists

Your ChatGPT subscription includes an allowance that participating apps can use on your behalf. OpenAI documents this as **Sign in with ChatGPT** with optional **ChatGPT plan usage**, and explicitly supports it for **open-source tools and personal projects that run locally**.

Most community bridges in this space put an OpenAI-compatible API in front of the **Codex HTTP backend** (`chatgpt.com/backend-api/codex`) — an undocumented path tied to your `~/.codex/auth.json`, which their own READMEs warn "may change without notice."

**This project deliberately does not do that.** It uses the documented, first-party path:

| | This project | Typical community bridge |
| --- | --- | --- |
| Auth | Official OAuth 2.0 + PKCE, dynamic client registration | Reads a Codex CLI credential file |
| Inference | `POST https://api.openai.com/v1/responses` | `chatgpt.com/backend-api/codex/*` |
| Model list | `GET https://api.openai.com/v1/models` | Bundled / cached catalog |
| Credentials | OS keychain, with a documented fallback | Plain file |
| Billing | ChatGPT plan usage, granted by the user | ChatGPT plan usage, implicitly |

---

## Requirements

- **Node.js 18+** — nothing else. **Zero runtime dependencies**; no `npm install` needed.
- A **ChatGPT Plus or Pro** account.
- macOS, Linux, or Windows.

---

## Install

```bash
git clone https://github.com/zhiqiang73-cpu/chatgpt-plan-bridge.git
cd chatgpt-plan-bridge
node bin/cpb.js login
```

`login` opens your browser for the official OAuth flow and stores credentials in your OS keychain. Then:

```bash
node bin/cpb.js status
node bin/cpb.js models
node bin/cpb.js ask "Explain what an idempotent HTTP method is" --model <id-from-models>
```

To get a global `cpb` command:

```bash
npm link          # or: ln -s "$PWD/bin/cpb.js" /usr/local/bin/cpb
```

---

## MCP setup

`cpb mcp` speaks MCP over stdio, so any MCP client can launch it on demand — no daemon, no open port.

**Tools exposed**

| Tool | Purpose |
| --- | --- |
| `chatgpt_status` | Connection state, whether plan usage was granted, storage backend |
| `chatgpt_models` | Live model list for the signed-in account |
| `chatgpt_ask` | Run one prompt against a chosen model |

**Example client config**

```json
{
  "mcpServers": {
    "chatgpt-plan-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/chatgpt-plan-bridge/bin/cpb.js", "mcp"]
    }
  }
}
```

---

## OpenAI-compatible HTTP

```bash
cpb serve --port 18888 --api-key <your-local-key>
```

| Endpoint | Notes |
| --- | --- |
| `GET /v1/models` | Live catalog |
| `POST /v1/responses` | Responses API shape; supports `stream: true` |
| `POST /v1/chat/completions` | Chat Completions shape; supports `stream: true` |
| `GET /` | Local console — sign in, browse models, test inference, view evidence |

Point any OpenAI client at it:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:18888/v1
export OPENAI_API_KEY=<your-local-key>
```

> **Always set `--api-key`.** The server binds to `127.0.0.1`, but any local process can reach a loopback port. Without a key, any program on your machine — including a stray dependency — could spend your ChatGPT plan.

---

## Credential storage

Credentials are stored in the OS secret store, with an automatic and documented fallback:

| Platform | Backend |
| --- | --- |
| macOS | Keychain (`security`) |
| Linux | Secret Service (`secret-tool`) |
| Windows | DPAPI, current user (`powershell`) |
| Fallback | Plain `0600` file at `~/.config/chatgpt-plan-bridge/credentials.json` |

The fallback triggers only when the platform store is unavailable — for example a headless container without libsecret, or a restricted execution session. `cpb status` always reports which backend is actually in use, and a fallback emits a warning. **Credentials are never written to logs and never printed.**

---

## What gets stored and logged

| Path | Contents |
| --- | --- |
| OS keychain | `access_token`, `refresh_token`, `id_token` |
| `state/chatgpt-host.json` | This installation's host ID — not sensitive |
| `logs/*.json` | Model catalog, results, outbound request summary — **no tokens** |

---

## How the official flow works

Documented at <https://developers.openai.com/siwc/token-sharing-open-source/sign-in> and <https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference>.

**Authorize**

| Parameter | Value |
| --- | --- |
| Endpoint | `https://auth.openai.com/api/accounts/authorize` |
| `client_id` | `dynamic_agent_client` on first registration; the issued `oaiapp_*` afterwards |
| `agent_name_hint` | Your app name — **first registration only** |
| `ext_agent_host_id` | `urn:uuid:…`, unique per installation |
| `redirect_uri` | `http://127.0.0.1:<port>/auth/callback` — loopback; `localhost` is not accepted |
| `scope` | `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct` |
| `resource` | `https://api.openai.com/v1` |
| Other | `state`, `nonce`, PKCE `S256` |

The callback returns the code **and the issued `client_id`**. Exchange the code at `https://auth.openai.com/api/accounts/oauth/token` with that issued client ID, the PKCE verifier, the same `redirect_uri`, and the same `resource`.

**Infer** — `store: false` and `stream: true` are required. Success means you received `response.completed`, not merely HTTP 200.

---

## Two gotchas worth knowing

1. **The streaming response has no `content-type` header.** `POST /v1/responses` returns 200 with `content-type: null` and only `transfer-encoding: chunked`. Any client that gates on `text/event-stream` will misreport a working request as a failure. Decide from the HTTP status plus the parsed events.
2. **Failures can arrive after the stream opens.** A plan-usage error comes back as `response.failed` inside an HTTP **200** stream. Only `response.completed` means success. This bridge maps such failures to a proper status code (e.g. `429`) for callers rather than passing the misleading 200 through.

---

## Compliance and scope

| Use | Allowed? |
| --- | --- |
| Open source, run locally, free | ✅ Explicitly supported |
| Each user signs in with their own account | ✅ This is the intended design |
| Charging for it, or hosting it as a service for others | ❌ Requires an [OpenAI partner request](https://openai.com/form/sign-in-with-chatgpt-interest/) |
| Copying OpenAI's DevKit code | ❌ That code is under a noncommercial licence |

This project is an **independent implementation written from OpenAI's public documentation**. It does not include or derive from the DevKit source.

---

## Usage limits

Plan usage is a shared allowance, not an unlimited pool:

- You can set a **per-app weekly limit** in ChatGPT → **Settings → Usage**. That limit is a **cap, not a separate pool** — the app can hit its cap while your plan still has usage left.
- `subscription_sharing_usage_limit_exceeded` can mean *either* an app-level cap *or* an overall plan limit. You cannot tell which from the code alone, and you cannot infer a reset time from it.
- Signing in again or retrying does **not** restore usage.
- After included usage runs out, apps can use credits only if the user has opted in **and** the app's limit is set to 100%.

This project surfaces these errors verbatim, with a link to <https://chatgpt.com/settings/usage>, rather than guessing.

---

## Limitations

- **Single account.** Multi-account / multi-workspace switching is not implemented yet.
- **Text only.** Tools, images, and structured outputs are not passed through yet.
- **No background service.** `serve` runs in the foreground; it does not register a LaunchAgent or systemd unit. MCP clients launch `cpb mcp` on demand instead.
- macOS is the primary test target.

---

## Documentation

| Document | Contents |
| --- | --- |
| [RESULT.md](RESULT.md) | Verification report: the full official chain, with evidence |
| [docs/deployment-and-open-source.md](docs/deployment-and-open-source.md) | Running on other machines; release checklist |
| [docs/product-and-residency-plan.md](docs/product-and-residency-plan.md) | Product positioning, constraints, and roadmap |
| [SECURITY.md](SECURITY.md) | Credential handling and disclosure policy |

---

## License

[Apache-2.0](LICENSE) — includes an explicit patent grant.

OpenAI-authored DevKit code and assets are **not** used by this project and remain under their own noncommercial licence. OpenAI trademarks remain subject to the [OpenAI brand guidelines](https://openai.com/brand/).
