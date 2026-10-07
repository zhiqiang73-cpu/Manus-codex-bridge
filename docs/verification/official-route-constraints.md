# Official route constraints

Measured behaviour of `POST https://api.openai.com/v1/responses` when called with an access
token authorized for ChatGPT plan usage.

Captured 2026-10-07. Reproduce with:

```bash
node scripts/verify/probe-official-constraints.mjs
```

## Probe matrix

| # | Probe | Result |
| --- | --- | --- |
| A | plain text `input` | **200** |
| B | `instructions` field | **200** |
| C | top-level `{type:"message", role:"system"}` item | **400** `System messages are not allowed` |
| D | top-level `tools`, **flat** format | **200** |
| E | top-level `tools`, nested `function:{}` format | **400** `Missing required parameter: 'tools[0].name'` |
| F | `temperature` | **400** `Unsupported parameter: temperature` |
| G | `max_output_tokens` | **400** `Unsupported parameter` |

## What this means for a bridge

The official route is **stricter** than the legacy Codex HTTP backend. A bridge that forwards
OpenAI Chat Completions payloads verbatim will fail. Three transformations are mandatory:

### 1. System messages must become `instructions`

Top-level system message items are rejected outright. Fold every `system` / `developer` message
into the request's `instructions` string:

```js
const system = messages
  .filter((m) => m.role === 'system' || m.role === 'developer')
  .map((m) => textOf(m.content))
  .join('\n\n');

const payload = { model, input, store: false, stream: true };
if (system) payload.instructions = system;
```

### 2. Tools must be flattened

Chat Completions nests the definition under `function`; the official route wants the fields at
the top level:

```js
// Chat Completions            ->  official Responses
{ type: 'function',             { type: 'function',
  function: {                     name: f.name,
    name, description,            description: f.description || '',
    parameters } }                parameters: f.parameters,
}                                 strict: false }
```

`tool_choice` follows the same shape: `'auto' | 'none' | { type: 'function', name }`.

### 3. Unsupported parameters must be dropped

Verified rejected: `temperature`, `max_output_tokens`.

Also treated as unsupported by this route (strip before forwarding):
`top_p`, `top_logprobs`, `max_tool_calls`, `metadata`, `moderation`, `prompt`,
`prompt_cache_retention`, `safety_identifier`, `truncation`, `user`, `background`,
`conversation`, `previous_response_id`, `multi_agent`.

## Always send `store: false` and `stream: true`

`store: false` avoids server-side retention. The route is designed around streaming; a bridge can
still serve non-streaming clients by aggregating the SSE events itself.

## One caveat when aggregating

In observed responses, the `response.completed` event's `output` array can be **empty** even
though text was streamed. Do not rely on it to reconstruct the answer, and do not use it to
decide `finish_reason`:

- accumulate text from `response.output_text.delta`
- track whether any `response.output_item.added` had `item.type === 'function_call'` to decide
  between `finish_reason: "tool_calls"` and `"stop"`

Ignoring this produces streaming responses that end with `finish_reason: "stop"` while
`tool_calls` were actually emitted.
