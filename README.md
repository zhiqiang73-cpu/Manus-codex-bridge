# ChatGPT Plan Bridge

> **Not affiliated with, endorsed by, or sponsored by OpenAI.** "ChatGPT" and "OpenAI" are trademarks of OpenAI. This is an independent open-source project.

Use the ChatGPT plan you already pay for — **Plus or Pro** — in your own local tools, through OpenAI's **official** sign-in and Responses API. No API key. No per-token billing.

```
Your tool  →  this bridge (local)  →  auth.openai.com (OAuth)  →  api.openai.com/v1/responses
                                     └─ counts against your ChatGPT plan usage
```

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
| Billing | ChatGPT plan usage, granted by the user | ChatGPT plan usage, implicitly |

---

## Status

Working prototype. The full chain has been verified end to end against a real Plus account:

- OAuth dynamic registration → issued client ID
- ID token verified (signature, issuer, audience, expiry)
- `GET /v1/models` → account-specific catalog
- `POST /v1/responses` → streamed completion

See [RESULT.md](RESULT.md) for the raw evidence, including the two non-obvious gotchas found during testing.

**Not yet production-ready.** See [Limitations](#limitations).

---

## Requirements

- **Node.js 18+** — nothing else. There are **zero runtime dependencies**; no `npm install` needed.
- A **ChatGPT Plus or Pro** account.
- macOS, Linux, or Windows.

---

## Quick start

```bash
git clone <this-repo>
cd <this-repo>
node src/server.js
```

Open <http://127.0.0.1:18888/> and:

1. **Sign in with ChatGPT** — completes OAuth in your browser
2. Approve the **ChatGPT plan usage** permission (without it you get no access token)
3. **Refresh Models** — the dropdown is populated from what the server actually returns
4. Pick a model → **Test Inference**

### Command line

```bash
node scripts/test-models.mjs "your prompt"   # test every model the account exposes
```

### Files produced

| Path | Contents |
| --- | --- |
| `logs/models.json` | The real model catalog returned by the server |
| `logs/poc-result.json` | Step-by-step result and evidence |
| `logs/oauth-result.json` | Auth outcome and ID token verification |
| `logs/outbound.json` | Every outbound request (method, origin+path, status) |
| `state/credentials.json` | Credentials, mode `0600` — never committed, never logged |

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
2. **Failures can arrive after the stream opens.** A plan-usage error comes back as `response.failed` inside an HTTP **200** stream. Only `response.completed` means success.

---

## Compliance and scope

This project is built to stay inside what OpenAI actually permits:

| Use | Allowed? |
| --- | --- |
| Open source, run locally, free | ✅ Explicitly supported |
| Each user signs in with their own account | ✅ This is the intended design |
| Charging for it, or hosting it as a service for others | ❌ Requires an [OpenAI partner request](https://openai.com/form/sign-in-with-chatgpt-interest/) |
| Copying OpenAI's DevKit code | ❌ That code is under a noncommercial licence |

This project is an **independent implementation written from OpenAI's public documentation**. It does not include or derive from the DevKit source.

If you intend to build a paid or remotely hosted product, contact OpenAI first. Do not use this project to resell access.

---

## Usage limits

Plan usage is a shared allowance, not an unlimited pool. A few things that surprise people:

- You can set a **per-app weekly limit** in ChatGPT → **Settings → Usage**. That limit is a **cap, not a separate pool** — the app can hit its cap while your plan still has usage left.
- `subscription_sharing_usage_limit_exceeded` can mean *either* an app-level cap *or* an overall plan limit. You cannot tell which from the code alone, and you cannot infer a reset time from it. Point users at <https://chatgpt.com/settings/usage>.
- Signing in again or retrying does **not** restore usage.
- After included usage runs out, apps can use credits only if the user has opted in **and** the app's limit is set to 100%.

This project surfaces these errors verbatim rather than guessing.

---

## Limitations

- Credentials are stored in a plain `0600` file. **OS keychain storage is not implemented yet** — this must be done before distributing the tool to others. See [SECURITY.md](SECURITY.md).
- Single account profile. Multi-account / multi-workspace switching is not implemented.
- The structured error table from OpenAI's docs is only partially mapped.
- No MCP server or OpenAI-compatible HTTP surface yet — currently a local console plus a test script.
- macOS has been the primary test target.

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
