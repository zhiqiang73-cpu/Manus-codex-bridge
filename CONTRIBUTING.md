# Contributing

Thanks for helping. A few ground rules matter more here than in most projects.

## Hard rules

1. **Never commit credentials.** `state/` and `logs/` are gitignored. Before your first commit, run `git status` and confirm neither appears.
2. **Never print or log tokens.** No `access_token`, `refresh_token`, or `id_token` in stdout, logs, error messages, screenshots, or test fixtures.
3. **Never add the Codex backend.** This project intentionally uses only documented OpenAI endpoints (`auth.openai.com`, `api.openai.com`). PRs that add `chatgpt.com/backend-api/*` will be declined.
4. **Never add API-key billing paths.** The point is to use a ChatGPT plan, not an OpenAI API key.
5. **Keep it dependency-free if you reasonably can.** Zero runtime dependencies is a feature.

## Before opening a PR

- Run the chain against your own account and confirm `response.completed`.
- Confirm no token-shaped strings ended up in `logs/`.
- Update the relevant doc under `docs/` if you change behaviour.

## Reporting bugs

Include: OS and Node version, the exact request, the HTTP status, the `error.code` if present, and what you expected. **Redact** tokens, account emails, and subject identifiers.

## Security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).

## Scope

This project is for **local, personal, open-source** use. Contributions aimed at commercial hosting, reselling access, or bypassing plan limits are out of scope.
