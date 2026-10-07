# Quota attribution: which usage bucket is consumed?

**Finding: inference is served by the Codex serving stack and attributed to the ChatGPT plan.
It is not billed against API limits.**

Captured 2026-10-07 against a ChatGPT Plus account. Reproduce with:

```bash
node scripts/verify/check-quota-usage.mjs
node scripts/verify/inspect-usage-attribution.mjs
```

## Evidence 1 — Codex-specific response headers

`POST /v1/responses` returns headers that only the Codex serving stack emits:

| Header | Observed value |
| --- | --- |
| `x-codex-safety-buffering-enabled` | `true` |
| `x-codex-safety-buffering-faster-model` | `gpt-6-luna` |
| `x-codex-turn-state` | ~700-character turn-state token |

All three present together indicates the request is handled by Codex infrastructure rather than
a plain API billing path.

## Evidence 2 — no API rate-limit headers at all

A standard API call returns `x-ratelimit-limit-requests`, `x-ratelimit-remaining-tokens`, and
friends. **None are present here**, across repeated calls:

```
quota / rate-limit headers across two calls
  x-codex-safety-buffering-enabled       true         true
  x-codex-safety-buffering-faster-model  gpt-6-luna   gpt-6-luna
  x-codex-turn-state                     (per-call token)
  x-oai-request-id                       req_…        req_…
```

No rate-limit headers means the request is not counted against API RPM/TPM quotas.

## Evidence 3 — `usage.attribution` is per-message

The response `usage` object carries a per-message attribution structure:

```json
{
  "attribution": {
    "items": {
      "msg_…e20": { "input_tokens": 9, "output_tokens": 0 },
      "msg_…5d3": { "input_tokens": 2, "output_tokens": 6 }
    }
  },
  "input_tokens": 11,
  "output_tokens": 6,
  "total_tokens": 17
}
```

Plain API responses return aggregate counters only. Per-message attribution is the shape used
for plan accounting.

## Evidence 4 — plan-side markers

| Field | Observed value |
| --- | --- |
| `access_programs` | `{ "cyber": "standard" }` |
| `safety_identifier` | `user-…` (per-account identifier) |
| `prompt_cache_key` | present (UUID) |
| `prompt_cache_retention` | `24h` |
| `service_tier` | `default` |

`access_programs` declares which programs the account may use; it does not appear in ordinary
API responses.

## Summary

| Question | Answer |
| --- | --- |
| Public API endpoint? | Yes — `api.openai.com/v1/responses`, not `backend-api` |
| Authorization | Official `chatgpt.tokens.use.direct` (Sign in with ChatGPT) |
| API charges incurred? | No — no API billing or rate-limit headers present |
| Who serves the request? | The Codex serving stack (`x-codex-*` headers) |
| Where does usage land? | Your ChatGPT plan, attributed per message |

## Honest boundary

This is a **server-side evidence chain**, not a screenshot of your usage meter. The definitive
confirmation is a before/after comparison in your own account:

1. Open ChatGPT → Settings → Usage and note the Codex allowance
2. Run `mcb ask "Reply exactly: quota probe" --model gpt-6-astra`
3. Refresh the usage page

If that number moves, the attribution is confirmed. If it does not, please open an issue with the
result — it would mean the behaviour changed.
