# Verification

Reproducible evidence for the claims **manus-codex-bridge** makes about the official
ChatGPT Plan Usage route.

Everything here was captured against a real ChatGPT Plus account on **2026-10-07** using only
public endpoints (`https://api.openai.com/v1/*`). No `backend-api`, no API key.

| Document | Answers |
| --- | --- |
| [`official-route-constraints.md`](official-route-constraints.md) | What does the official Responses route actually accept and reject? |
| [`quota-attribution.md`](quota-attribution.md) | Which usage bucket does this draw from — ChatGPT plan or API? |

## Running the scripts

All scripts are dependency-free (Node 18+) and read the access token from, in order:

1. `OPENAI_OAUTH_TOKEN`
2. `--token-file=<path>` or `CHATGPT_PLAN_CREDENTIALS`
3. `~/.config/chatgpt-plan-relay/credentials.json`

```bash
export OPENAI_OAUTH_TOKEN="$(mcb token)"   # or point at a credentials JSON

node scripts/verify/probe-official-constraints.mjs   # what the route accepts / rejects
node scripts/verify/verify-official-plan-usage.mjs   # end-to-end gates + one real call
node scripts/verify/check-quota-usage.mjs            # response headers, quota comparison
node scripts/verify/inspect-usage-attribution.mjs    # usage.attribution structure
```

Set `PROBE_MODEL` to pin a model; otherwise the scripts use `gpt-6-astra`.

## Token handling

These scripts **read** a token and never write, log or persist one. Output is limited to a
SHA-256 fingerprint. Do not paste raw tokens into issues or logs.

## Scope note

The results below describe a **preview** feature. OpenAI can change the accepted parameter set
at any time; re-run the probes if behaviour appears to shift.
