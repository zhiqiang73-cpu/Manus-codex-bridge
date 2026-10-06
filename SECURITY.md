# Security

This tool handles OAuth credentials for a user's ChatGPT account. Please read this before using or contributing.

## What this tool stores

| Data | Location | Protection |
| --- | --- | --- |
| OAuth `access_token` / `refresh_token` / `id_token` | `state/credentials.json` | file mode `0600` |
| This installation's host ID | `state/chatgpt-host.json` | not sensitive |
| Model catalog, request log, results | `logs/*.json` | contains **no** tokens |

`state/` and `logs/` are excluded via `.gitignore` and must never be committed.

## Design rules this project follows

1. **Tokens are never printed.** Not to stdout, not to logs, not to the browser, not to error messages.
2. **Tokens are never written to `logs/`.** Log files are audited for JWT-shaped strings and long base64 blobs.
3. **No OpenAI API key is read.** `OPENAI_API_KEY` is unset and ignored at startup, so a leftover key cannot silently take over billing.
4. **Loopback only.** The HTTP server and the OAuth callback bind to `127.0.0.1`. Never expose it to a network.
5. **Only official endpoints.** Requests go to `auth.openai.com` and `api.openai.com` only.

## Known limitation

Credentials are stored in a plain `0600` file. This is acceptable for local single-user use but **not** sufficient for distributing the tool to other people. Moving credentials into the OS keychain (macOS Keychain / Windows Credential Manager / libsecret) is required before wide distribution. See `docs/deployment-and-open-source.md`.

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Use GitHub's private vulnerability reporting on this repository, or contact the maintainer directly.

Include: affected version or commit, what an attacker can achieve, and reproduction steps. Do not include real tokens, real account emails, or other people's credentials in your report.
