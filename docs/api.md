# API

Base URL is your Worker (`https://agent-mail-track.<account>.workers.dev` or `https://track.greatindiancompany.com` after you attach the domain).

Auth for `/v1/*` and the dashboard (`GET /`, `GET /m/:id`):

- `Authorization: Bearer <API_KEY>`
- or HTTP Basic (username ignored, password = `API_KEY`) — browsers use this for the dashboard

`GET /health`, `GET /o/:token`, and `GET /c/:token` are unauthenticated.

This service **does not send email**. Agents POST content, receive instrumented content + `message_id`, and send via their own Gmail/SMTP/etc. In-repo reference: [`client/`](../client/index.ts) and `npm run send-tracked` (SMTP or Gmail raw — **not** `htmlBody`). Attached agents use the [MCP](./mcp.md): **For open tracking, call AMT MCP send_tracked_email — do not use Gmail MCP send_message.**

**Open tracking requires the HTML `<img>` to survive send.** `POST /v1/messages` returns `raw_mime` and `raw_base64url` for that. Gmail MCP / connector `htmlBody` **strips `<img>` tags** — do not use it for tracked mail. See [agent-send.md](./agent-send.md).

## `GET /health`

```json
{ "ok": true, "service": "agent-mail-track", "version": "0" }
```

## `POST /v1/messages`

Create a tracked message and receive instrumented bodies.

```json
{
  "to": "ada@example.com",
  "from": "you@gmail.com",
  "subject": "Hello",
  "text": "Hi Ada,\n\nSee https://example.com/docs and write back.",
  "html": "<p>optional; required for mode=html</p>",
  "mode": "plain_looking",
  "metadata": { "agent": "research-bot", "thread": "t-1" },
  "webhook_url": "https://hooks.example.com/mail",
  "base_url": "https://track.greatindiancompany.com"
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `to` | yes | Recipient. Must contain `@`. Used in the RFC822 `To` header. |
| `from` | no | Optional RFC822 `From`. Must contain `@`. Gmail requires this to be the authenticated user or a send-as alias; omit to let Gmail fill it. |
| `subject` | no | Max 500 chars |
| `text` | yes except `html` mode | Prose for `plain_looking` / `plain_only` |
| `html` | yes in `html` mode | Existing HTML to instrument |
| `mode` | no | `plain_looking` (default) \| `plain_only` \| `html` |
| `metadata` | no | JSON object, max ~8 KiB |
| `webhook_url` | no | HTTPS (or `http://localhost`) — first open / first click |
| `base_url` | no | Origin for absolute pixel/click URLs. Defaults to this request's origin. **Persisted** so later GETs keep this host. |

### Modes

**`plain_looking` (default)** — input prose becomes a multipart/alternative pair:

- `text`: original prose with `http(s)` URLs rewritten to `/c/:token`
- `html`: bare twin (`<p>` / `<br>` / `<a>` only, no campaign CSS) plus a 1×1 `<img>` pixel at `/o/:token`

Prefer the returned **`raw_mime` / `raw_base64url`** instead of assembling MIME yourself. That payload is already `multipart/alternative` (`text/plain` + `text/html`) with the 1×1 pixel in the HTML part.

Do **not** send `html` through Gmail `htmlBody` — the connector strips `<img>`.

**`plain_only`** — keep text; rewrite `http(s)` links only. No HTML, no pixel.

```json
{ "open_tracking": false, "opens": null, "html": null, "pixel_url": null }
```

Never interpret `opens: null` as zero opens.

**`html`** — instrument the provided HTML: rewrite `http(s)` `href`s (skip `mailto:`, `tel:`, `#`, `javascript:`, `data:`), inject a pixel before `</body>` if one is not already present.

### Response `201`

```json
{
  "message_id": "msg_…",
  "mode": "plain_looking",
  "open_tracking": true,
  "opens": 0,
  "clicks": 0,
  "status": "no_signal",
  "replied": false,
  "to": "ada@example.com",
  "from": "you@gmail.com",
  "subject": "Hello",
  "text": "…rewritten…",
  "html": "<p>…</p>\n<img src=\"https://…/o/…\" width=\"1\" height=\"1\" alt=\"\">",
  "raw_mime": "MIME-Version: 1.0\r\nDate: …\r\n…multipart/alternative…<img src=\"https://…/o/…\">…",
  "raw_base64url": "TUlNRS1WZXJzaW9uOiAxLjA…",
  "pixel_url": "https://…/o/msg_….sig",
  "base_url": "https://track.greatindiancompany.com",
  "links": [
    { "id": "lnk_…", "original_url": "https://example.com/docs", "tracked_url": "https://…/c/lnk_….sig" }
  ],
  "metadata": { "agent": "research-bot" },
  "created_at": "2026-09-11T02:15:00.000Z"
}
```

| Response field | Notes |
| --- | --- |
| `raw_mime` | Full RFC 5322 message (CRLF). SMTP `DATA`. HTML part contains the `/o/` pixel when `open_tracking` is true. |
| `raw_base64url` | `raw_mime` encoded for Gmail API `{ raw }`. |
| `html` / `text` | Convenience copies. Unsafe for Gmail `htmlBody` (images stripped). |
| `base_url` | Origin baked into pixel and click URLs. |

For `plain_only`, `opens` is `null`, `open_tracking` is `false`, and `raw_mime` is `text/plain` only (no pixel — never claim opens).

Errors: `400` `{ "error": "…" }` (`invalid_to`, `text_required`, `html_required`, `invalid_mode`, …), `401` unauthorized.

## `GET /v1/messages`

List recent messages for the dashboard and agents.

`?limit=` default 50, max 100.

```json
{
  "messages": [
    {
      "message_id": "msg_…",
      "to": "ada@example.com",
      "subject": "Hello",
      "mode": "plain_looking",
      "open_tracking": true,
      "opens": 1,
      "clicks": 0,
      "status": "proxy_open",
      "replied": false,
      "created_at": "…",
      "first_open_at": "…",
      "first_click_at": null,
      "last_classification": "gmail_proxy",
      "last_event_at": "…",
      "metadata": {}
    }
  ]
}
```

`status` values: `replied` (unused in v0) \| `clicked` \| `high_confidence_open` \| `proxy_open` \| `no_signal`. See [events.md](./events.md).

## `GET /v1/messages/:id`

Same object plus `links[]`, `events[]` timeline (`ip_hash`, `classification`, `deduped`, `user_agent`, `cf_country`, `original_url` on clicks), `base_url`, and current `pixel_url` when open tracking is on.

`pixel_url` and each `tracked_url` use the **`base_url` stored at create time**, not the `Host` of this GET (so a workers.dev request does not rewrite a custom-domain pixel). Bodies / `raw_mime` are not persisted; use the create response to send.

`404` `{ "error": "not_found" }`.

## `GET /o/:token`

Record an open. Returns a 1×1 GIF. Invalid tokens still return the GIF.

## `GET /c/:token`

Record a click and `302` to the stored original URL (`http`/`https` only). `404` if the token is unknown; `400` if the destination is unsafe.

## Dashboard

| Path | Auth | Body |
| --- | --- | --- |
| `GET /` | Bearer or Basic | Recent messages, status pills, open/click counts |
| `GET /m/:id` | Bearer or Basic | Detail + event timeline |

Hand-rolled HTML/CSS. No JS framework.

## Curl smoke

Replace `$HOST` and `$API_KEY`.

```bash
curl -sS "$HOST/health"

# 1) plain_looking (default)
curl -sS -X POST "$HOST/v1/messages" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"to":"ada@example.com","subject":"Hello","text":"Hi Ada,\n\nSee https://example.com/docs and write back."}'

# 2) plain_only — expect open_tracking:false and opens:null
curl -sS -X POST "$HOST/v1/messages" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"mode":"plain_only","to":"ada@example.com","text":"Plain https://example.com"}'

# 3) html
curl -sS -X POST "$HOST/v1/messages" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"mode":"html","to":"ada@example.com","html":"<html><body><p>Hi <a href=\"https://example.com\">docs</a> <a href=\"mailto:ada@example.com\">mail</a></p></body></html>"}'

curl -sS -H "Authorization: Bearer $API_KEY" "$HOST/v1/messages"
curl -sS -H "Authorization: Bearer $API_KEY" "$HOST/v1/messages/$MESSAGE_ID"

# Open pixel (no auth) — save GIF, check Content-Type
curl -sS -D- "$HOST/o/$OPEN_TOKEN" -o /tmp/amt.gif

# Click (no auth) — expect 302 Location: https://example.com/...
curl -sS -D- -o /dev/null "$HOST/c/$CLICK_TOKEN"
```

Do not put mailbox passwords, Gmail OAuth tokens, or SMTP secrets in this repo or in Worker env for v0.
