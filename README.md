# Agent Mail Track

**Build the method by which AI agents insert open/click tracking into their outbound mail workflow.** Chrome MailTrack-class extensions miss agent API sends; AMT exists so agents don’t depend on connector HTML sanitizers or vendor fixes.

AMT is the **bridge** when we cannot change upstream connectors (Grok Bot / xAI, ChatGPT, Claude, Outlook MCP, Gmail MCP, …). Those often sanitize `htmlBody` and strip `<img>`, or expose no raw send. AMT does **not** replace Gmail or Outlook — it mints instrumented MIME (`raw_mime` / `raw_base64url`) so any office can wrap send.

Open-source, self-hostable. A Cloudflare Worker instruments content; opens and clicks land in D1. Agents poll JSON. Humans get a thin dashboard. This Worker **does not send email**. The in-repo `client/` + `npm run send-tracked` wrap mint → SMTP / Gmail raw so agents can actually deliver the pixel.

**Office shim:** default-on `sendTrackedEmail` — mint, then send via that provider’s img-preserving path (Gmail raw, Outlook Graph MIME, SMTP DATA). Agents never mint by hand. Spec: [docs/send-tracked-email-shim.md](./docs/send-tracked-email-shim.md). Reference implementation: [`client/`](./client/index.ts) (`npm run send-tracked`).

**For open tracking, call AMT MCP send_tracked_email — do not use Gmail MCP send_message.**

Gmail and Outlook MCP compose (`send_message`, `htmlBody`, `textBody`) strip `<img>` pixels. The tracking Worker stays mint+track and does not send mail. Attach the in-repo Node MCP ([`mcp/`](./mcp/stdio.ts)), which wraps [`client/`](./client/index.ts): it mints here, then delivers `raw_mime` over SMTP or `raw_base64url` via Gmail API `{ raw }`. Mailbox secrets stay in the agent process (`AMT_API_KEY`, `SMTP_*`, `GMAIL_ACCESS_TOKEN`), not in git and not on the Worker. Tool reference: [docs/mcp.md](./docs/mcp.md).

## Quickest working path (agent send)

Use the Node client: mint, then SMTP `DATA` of `raw_mime`. **Never** `htmlBody` (Gmail/Outlook connectors strip `<img>` and opens stay `no_signal`).

```ts
import { sendTrackedEmail } from "./client/index.ts";
await sendTrackedEmail({
  baseUrl: process.env.AMT_BASE_URL!, apiKey: process.env.AMT_API_KEY!,
  to: "ada@example.com", from: "you@icloud.com",
  subject: "Hello", text: "Hi Ada — see https://example.com/docs",
  via: "smtp", smtp: { host: "smtp.mail.me.com", port: 587, user: process.env.SMTP_USER!, pass: process.env.SMTP_PASS! },
});
```

CLI: `npm run send-tracked -- --to ada@example.com --from you@icloud.com --subject Hello --text "Hi"`. Env: `AMT_API_KEY`, `AMT_BASE_URL`, `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` (or `GMAIL_ACCESS_TOKEN` + `--via gmail_raw`; needs `gmail.send`). Details: [docs/agent-send.md](./docs/agent-send.md). AMT vs Postal (MTA): [docs/compare-postal.md](./docs/compare-postal.md).

### Researcher GTM: eSlams batch wave prepare (mint-only)

For the **eSlams Researcher GTM** 500-row cold wave, mint first so every mailmerge row logs an AMT `amt_message_id` (Sheet sync later). **`--mint-only` does not send mail.** Bodies have **no URLs** — do not invent links (click tracking N/A). Never `htmlBody`. AMT stays mint+track; this is not Postal.

Mailmerge columns: `send_batch_order,contact_id,first_name,email,subject,body_text` (map `email`→`to`, `body_text`→`text` / `plain_looking`, `subject`→`subject`). `from` is `makriman@berkeley.edu` via `--from` / `AMT_FROM`.

```bash
npm run send-tracked-batch -- \
  --csv /workspace/eslams-outbound-500/MAILMERGE-E1.csv \
  --out /workspace/eslams-outbound-500/AMT-LOG-E1.csv \
  --mint-only --touch E1 \
  --campaign eslams-researcher-lowstakes-2026-09 \
  --from makriman@berkeley.edu
# default --delay-ms 1000; row errors are fail-soft
```

Log CSV keeps input columns and appends `campaign`, `touch`, `amt_message_id`, `sent_at`, `open_status`, `open_at`, `bounce_or_error` (`open_*` empty at prepare). Single-send CLI is unchanged: `npm run send-tracked`. See [docs/agent-send.md](./docs/agent-send.md#researcher-gtm--batch-wave-prepare).

> **Industry class: MCP / connector `htmlBody` strips the open pixel.** Compose helpers (Gmail MCP `send_message` / `create_draft`, Outlook MCP JSON body, similar tools) sanitize HTML and drop `<img>`. Inbox UNREAD can still clear; AMT stays `no_signal`. **Do not** send returned `html` through `htmlBody`. Use `raw_mime` / `raw_base64url`. Not Gmail-only — Outlook Graph send MIME is first-class next (same mint; not wired in this Worker). See [docs/agent-send.md](./docs/agent-send.md).

## Attach the MCP

From the repo root, with secrets only in the environment:

```bash
export AMT_API_KEY=…                              # Worker API_KEY
export AMT_BASE_URL=https://track.greatindiancompany.com
export SMTP_HOST=smtp.mail.me.com SMTP_PORT=587
export SMTP_USER=you@icloud.com SMTP_PASS=…       # app password
# or omit SMTP_* and set GMAIL_ACCESS_TOKEN (scope gmail.send)
npm run mcp                                       # stdio
```

Cursor / Claude Desktop (`mcp.json`). `cwd` is this repo. `npx tsx` keeps stdout free for the protocol (`npm run` can print extra lines).

```json
{
  "mcpServers": {
    "agent-mail-track": {
      "command": "npx",
      "args": ["tsx", "mcp/stdio.ts"],
      "env": {
        "AMT_API_KEY": "…",
        "AMT_BASE_URL": "https://track.greatindiancompany.com",
        "SMTP_HOST": "smtp.mail.me.com",
        "SMTP_PORT": "587",
        "SMTP_USER": "you@icloud.com",
        "SMTP_PASS": "…"
      }
    }
  }
}
```

Tools: `mint_tracked_message`, `send_tracked_email` (`from` required; `via` is `smtp` or `gmail_raw`), `get_tracked_message`, `mint_tracked_batch` (mint-only). `npm run mcp:http` listens on `127.0.0.1:3333` (`POST /mcp`). Set `AMT_MCP_HTTP_TOKEN` if you bind anything but localhost. Do not publish that port.

SMTP stays in the Node client (`node:net`). That is why this MCP is not a route on the Hono Worker.

Custom domain target: [`track.greatindiancompany.com`](https://track.greatindiancompany.com) (attach after deploy; not required to merge or to run on `*.workers.dev`).

## Non-goals (v0)

- Worker sending mail — this Worker never talks SMTP/Gmail/Graph. A **reference Node client** (`client/`) and the **Node MCP** (`mcp/`) mint then send through *your* mailbox. AMT is mint+track, not an MTA ([Postal comparison](./docs/compare-postal.md)).
- Chrome extension
- Hosting MCP inside the tracking Worker (agents attach `mcp/` instead; SMTP needs the Node client, and mailbox secrets stay off this Worker)
- Docker-first path / running a mail server
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
  |-- Gmail raw / Graph MIME / SMTP --------------------------->|
    |                              |<-- GET /o/:token  (open) ----|
    |                              |<-- GET /c/:token  (click) ---|
    |-- GET /v1/messages/:id ----->|                              |
    |<-- status, events, opens ----|                              |
```

1. `POST /v1/messages` with `to`, optional `from` / `subject`, `text` and/or `html`, optional `mode`.
2. Send the RFC822 on a path that **keeps `<img>`**: Gmail `{ "raw": raw_base64url }`, Outlook Graph send MIME, or SMTP `DATA` of `raw_mime`.
3. **Do not** paste `html` into any connector `htmlBody` / JSON HTML body — images are stripped.
4. Read `GET /v1/messages/:id` (`status`, `opens`, `clicks`, event timeline) and act.

Attached agents use `send_tracked_email` for steps 1–2 and `get_tracked_message` for step 4. **For open tracking, call AMT MCP send_tracked_email — do not use Gmail MCP send_message.**

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

Scripts: `deploy`, `db:migrate`, `types`, `check` (`tsc` + tests), `test`, `send-tracked` (one mint + SMTP/Gmail raw), `send-tracked-batch` (eSlams mailmerge; `--mint-only --touch E1 --from …`; no secrets in git), `mcp` (stdio), `mcp:http` (localhost Streamable HTTP).

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
# Send via Gmail raw / Graph MIME / SMTP — not htmlBody. See docs/agent-send.md.

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
npm run send-tracked -- --help
npm run send-tracked-batch -- --help
npm run mcp          # stdio MCP; requires AMT_API_KEY in the environment
```

## License

[MIT](./LICENSE). Inspiration and WhoReadMe design-only note: [CREDITS.md](./CREDITS.md).

No mailbox secrets belong in this repository.
