# Agent Mail Track

**Track email opens, clicks, and delivery in a form agents can read and act on.**

Open-source, self-hostable email telemetry for AI agents. A Cloudflare Worker instruments outbound message content; opens and clicks land in D1. Agents poll a JSON API. Humans get a thin dashboard.

This Worker **does not send email**. Agents `POST` message content, receive instrumented content plus a `message_id`, and send through their own Gmail / SMTP / ESP.

**Grok Bot / office:** wrap mint+send in a default-on `sendTrackedEmail` shim so agents never mint by hand. AMT still does not send — the office shim must. Spec: [docs/send-tracked-email-shim.md](./docs/send-tracked-email-shim.md).

> **Gmail connector `htmlBody` strips the open pixel.** Open tracking is a 1×1 `<img src="…/o/…">`. Gmail MCP `send_message` / `create_draft` `htmlBody` sanitizes and drops all `<img>` tags — the inbox can still mark UNREAD, but the tracker stays `no_signal`. **Do not** send the returned `html` through `htmlBody`. Use `raw_mime` / `raw_base64url` from `POST /v1/messages` with the Gmail API `{ "raw": "<raw_base64url>" }` (or SMTP that does not strip). See [docs/agent-send.md](./docs/agent-send.md).

Custom domain target: [`track.greatindiancompany.com`](https://track.greatindiancompany.com) (attach after deploy; not required to merge or to run on `*.workers.dev`).

## Non-goals (v0)

- Sending mail (SMTP, Gmail API, ESP wrappers)
- Chrome extension
- MCP server
- Docker-first path
- SaaS multi-tenant billing
- Reply detection (`replied` is a stub field)
- Copying [WhoReadMe](https://github.com/the-code-learner/WhoReadMe) (design-only, non-commercial — see [CREDITS.md](./CREDITS.md))

## How an agent uses it

```
Agent                         Worker                         Inbox
  |                              |                              |
  |-- POST /v1/messages -------->|                              |
  |<-- raw_mime / raw_base64url -|                              |
  |                              |                              |
  |-- Gmail API raw / SMTP ------------------------------------>|
  |                              |<-- GET /o/:token  (open) ----|
  |                              |<-- GET /c/:token  (click) ---|
  |-- GET /v1/messages/:id ----->|                              |
  |<-- status, events, opens ----|                              |
```

1. `POST /v1/messages` with `to`, optional `from` / `subject`, `text` and/or `html`, optional `mode`.
2. Send **`raw_base64url`** via Gmail API `users.messages.send` `{ "raw": "…" }` (or SMTP `DATA` of `raw_mime`). That RFC822 payload is `multipart/alternative` with the tracking `<img>` intact.
3. **Do not** paste `html` into Gmail MCP / connector `htmlBody` — images are stripped.
4. Read `GET /v1/messages/:id` (`status`, `opens`, `clicks`, event timeline) and act.

## Three modes (exactly these)

| Mode | Input | Output | Opens |
| --- | --- | --- | --- |
| `plain_looking` **(default)** | Prose `text` | Instrumented `text` + bare HTML twin (`<p>` / `<br>` / `<a>` only) + 1×1 pixel; `raw_mime` is `multipart/alternative` | Count (`0` until the pixel fires) |
| `plain_only` | Prose `text` | Instrumented `text` only; `http(s)` links rewritten; `raw_mime` is `text/plain` | **`opens: null`**, `open_tracking: false` — never claim `0` |
| `html` | Existing `html` | Pixel injected if missing; `http(s)` hrefs rewritten; skip `mailto:` / `tel:` / `#` | Count |

`http(s)` only. Click redirects refuse `javascript:`, `data:`, protocol-relative, and other schemes.

Open tracking is the 1×1 `<img>` pixel. CSS/`background-image` tricks are unreliable in mail clients — this API does not use them. Click rewriting still happens; it is not a substitute for opens.

## Architecture

- **Cloudflare Worker** (Hono + TypeScript) — API, pixel, click 302, dashboard HTML
- **D1** — `messages`, `links`, `events` (see [schema.sql](./schema.sql))
- **Secrets** — `API_KEY` (dashboard + `/v1`), `TOKEN_SECRET` (HMAC for `/o/` and `/c/` tokens)
- Events store **`ip_hash`**, never raw IP. Classification is best-effort (`gmail_proxy`, `apple_mpp`, `security_scanner`, `human_likely`, `unknown`).

**Status** (confidence hierarchy): `replied` (future) > `clicked` > `high_confidence_open` > `proxy_open` > `no_signal`.

Details: [docs/api.md](./docs/api.md), [docs/events.md](./docs/events.md).

## Deploy

Requires a Cloudflare account and [Wrangler](https://developers.cloudflare.com/workers/wrangler/).

```bash
npm install
cp .dev.vars.example .dev.vars   # local only; do not commit

# 1. Create D1 and paste database_id into wrangler.jsonc
npx wrangler d1 create agent-mail-track

# 2. Apply migrations (re-run after pulls that add migrations/0002_…)
npm run db:migrate                # local SQLite for wrangler dev
npm run db:migrate:remote         # production D1

# 3. Secrets (generate long random values; not mailbox passwords)
npx wrangler secret put API_KEY
npx wrangler secret put TOKEN_SECRET

# 4. Ship
npm run deploy                    # wrangler deploy
```

`wrangler.jsonc` ships with a placeholder `database_id`. Replace it with the UUID printed by `d1 create` before a remote deploy. Local `wrangler dev` works with the placeholder after `npm run db:migrate`.

Scripts: `deploy`, `db:migrate`, `types`, `check` (`tsc` + tests), `test`.

### Custom domain (`track.greatindiancompany.com`)

Do **not** block a merge or a first deploy on DNS. Attach when the zone lives in the same Cloudflare account:

1. Dashboard → **Workers & Pages** → `agent-mail-track` → **Settings** → **Domains & Routes** → **Add** → Custom Domain → `track.greatindiancompany.com`
2. Or uncomment the `routes` example in `wrangler.jsonc` (`pattern` + `zone_name`) and redeploy

Then pass `"base_url": "https://track.greatindiancompany.com"` on `POST /v1/messages` so pixels and clicks are absolute on that host (otherwise the Worker uses the request origin). The chosen origin is persisted; later `GET /v1/messages/:id` returns `pixel_url` / `tracked_url` on that host even if you call the API via `*.workers.dev`.

## Curl smoke

```bash
export HOST="http://127.0.0.1:8787"          # or your workers.dev / custom domain
export API_KEY="…"                             # same value as the Worker secret

curl -sS "$HOST/health"

# plain_looking (default) — expect html twin + pixel_url + raw_mime / raw_base64url + opens: 0
curl -sS -X POST "$HOST/v1/messages" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"to":"ada@example.com","subject":"Hello","text":"Hi Ada,\n\nSee https://example.com/docs and write back."}'
# Send with Gmail API raw — not htmlBody. See docs/agent-send.md.

# plain_only — expect open_tracking:false, opens:null, html:null
curl -sS -X POST "$HOST/v1/messages" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"mode":"plain_only","to":"ada@example.com","text":"Plain https://example.com"}'

# html — expect rewritten https href, untouched mailto, injected pixel
curl -sS -X POST "$HOST/v1/messages" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"mode":"html","to":"ada@example.com","html":"<html><body><p>Hi <a href=\"https://example.com\">docs</a> <a href=\"mailto:ada@example.com\">mail</a></p></body></html>"}'

curl -sS -H "Authorization: Bearer $API_KEY" "$HOST/v1/messages"
curl -sS -u ":$API_KEY" "$HOST/"              # dashboard (Basic)
```

Hit `pixel_url` (`GET /o/:token`) and a `tracked_url` (`GET /c/:token`) to record events, then `GET /v1/messages/:id`.

## Dashboard

`GET /` (Bearer or Basic). Message list and `/m/:id` timeline (opens, clicks, classification, confidence). Hand-rolled HTML/CSS.

## Develop

```bash
npm test
npm run check
npm run dev
```

## License

[MIT](./LICENSE). Inspiration and WhoReadMe design-only note: [CREDITS.md](./CREDITS.md).

No mailbox secrets belong in this repository.
