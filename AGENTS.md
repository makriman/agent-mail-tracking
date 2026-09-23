# Cloud Agents — Agent Mail Track

This repo is a Cloudflare Worker plus a Node client. The Worker mints tracked MIME and records opens and clicks in D1. It does not send mail. The client sends that MIME.

Do not deploy, do not merge, and do not change live Worker secrets from an agent task unless the founder asked for that explicitly. Berkeley Workspace SMTP and OAuth are out of scope (blocked). The historical green send path is iCloud SMTP (`smtp.mail.me.com:587`, STARTTLS), not a secret that belongs in git.

## Build and test

Node 20+.

```bash
npm install
npm test          # vitest
npm run check     # tsc (Worker + client) and vitest
```

Local Worker (optional, not required for `npm test`):

```bash
cp .dev.vars.example .dev.vars   # local only; never commit
npm run db:migrate               # local D1
npm run dev                      # wrangler dev
```

`npm run deploy` and `npm run db:migrate:remote` talk to the live Cloudflare account. Do not run them from a review or docs task.

## Layout

| Path | Role |
| --- | --- |
| `src/` | Hono Worker. `POST /v1/messages` mints. `GET /o/:token` pixel. `GET /c/:token` click redirect. `GET /` and `GET /m/:id` dashboard. |
| `migrations/`, `schema.sql` | D1 tables: `messages`, `links`, `events`. |
| `wrangler.jsonc` | Worker name, D1 binding `DB`, route `track.greatindiancompany.com`. No secrets in this file. |
| `client/` | Mint, then send. `via` is `smtp` or `gmail_raw` only. |
| `docs/` | API, send path, events. |

`API_KEY` and `TOKEN_SECRET` are Worker secrets (`wrangler secret put`). `.dev.vars` is gitignored. `.dev.vars.example` is placeholders only.

## Send path (do not regress)

Mint → send `raw_mime` (SMTP `DATA`) or `raw_base64url` (Gmail `users.messages.send` `{ raw }`).

Never `htmlBody`, `textBody`, or any connector JSON HTML body. Those strip `<img>` and opens stay `no_signal`.

- `plain_looking` (default) and `html`: the open pixel `<img src="…/o/…">` must be present in both `raw_mime` and the decoded `raw_base64url`.
- `plain_only`: text only, no open pixel. Do not claim `opens: 0`; the API uses `opens: null`.
- Do not add a code path that strips `<img>` or drops the HTML part from multipart MIME.

`client/` throws if `htmlBody` / `textBody` is set, and refuses to return or send a mint response whose `raw_base64url` does not match `raw_mime` or (except `plain_only`) is missing the pixel.

## Auth model

`/v1/*`, `GET /`, and `GET /m/:id` require `API_KEY` (Bearer or Basic password). Open and click URLs are unauthenticated HMAC tokens (`TOKEN_SECRET`), not a substitute for the API key. One key sees every message. That is single-tenant v0, not per-message auth.

## MCP

[PR #6](https://github.com/makriman/agent-mail-tracking/pull/6) (`cursor/amt-mcp-bridge-292a`) is a founder-gated draft. Do not merge it and do not fold `mcp/` into `main` until the founder says to ship it.

## Secrets

Never commit API keys, SMTP passwords, Gmail or Workspace OAuth tokens, or real `.dev.vars`. Do not invent Berkeley SMTP or OAuth credentials. Do not print live secrets into logs, PR bodies, or fixtures.
