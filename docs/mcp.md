# AMT MCP

**For open tracking, call AMT MCP send_tracked_email — do not use Gmail MCP send_message.**

Gmail MCP `send_message` / `create_draft` and Outlook MCP compose take `htmlBody` or `textBody` (or a JSON HTML body). Those paths sanitize HTML and strip the open-tracking `<img>`. AMT then stays `no_signal` even if the inbox clears UNREAD.

This MCP is the agent bridge. It wraps [`client/`](../client/index.ts):

1. Mint with `POST /v1/messages` on the tracking Worker.
2. Send the returned RFC822 on a path that keeps `<img>`: SMTP `DATA` of `raw_mime`, or Gmail API `users.messages.send` `{ "raw": raw_base64url }`.

The Worker product stays mint+track. It does not speak SMTP or Gmail. SMTP in `client/smtp.ts` uses Node sockets, and mailbox secrets must stay in the agent process, so the server lives in [`mcp/`](../mcp/stdio.ts) instead of a Hono route.

## Run

```bash
npm install
export AMT_API_KEY=…                 # same value as the Worker API_KEY
export AMT_BASE_URL=https://track.greatindiancompany.com
export AMT_FROM=you@icloud.com       # optional fallback for from
export SMTP_HOST=smtp.mail.me.com
export SMTP_PORT=587
export SMTP_USER=you@icloud.com
export SMTP_PASS=…                   # app password; never commit
npm run mcp                          # stdio
```

Gmail instead of SMTP: unset `SMTP_*` and set `GMAIL_ACCESS_TOKEN` (scope `https://www.googleapis.com/auth/gmail.send`). There is no OAuth UI in this repo.

Local HTTP (still this machine):

```bash
export AMT_MCP_HTTP_HOST=127.0.0.1   # default
export AMT_MCP_HTTP_PORT=3333        # default
export AMT_MCP_HTTP_TOKEN=…          # optional; required if you bind a public interface
npm run mcp:http                     # POST /mcp , GET /health
```

Do not expose `mcp:http`. The process can send mail with the SMTP or Gmail credentials in its environment.

Cursor / Claude config is in the [README](../README.md#attach-the-mcp). Prefer `npx tsx mcp/stdio.ts` so stdout stays the MCP protocol.

## Environment

| Variable | Role |
| --- | --- |
| `AMT_API_KEY` | Bearer token for the Worker. Required. |
| `AMT_BASE_URL` | Worker origin. Default `https://track.greatindiancompany.com`. |
| `AMT_FROM` | Fallback RFC822 From when a tool omits `from`. |
| `SMTP_HOST` `SMTP_PORT` `SMTP_USER` `SMTP_PASS` | SMTP DATA transport. Port `465` or `SMTP_SECURE=true` uses implicit TLS. |
| `GMAIL_ACCESS_TOKEN` | Gmail `users.messages.send` `{ raw }`. |
| `AMT_MCP_HTTP_HOST` `AMT_MCP_HTTP_PORT` `AMT_MCP_HTTP_TOKEN` | Local HTTP bind. Default `127.0.0.1:3333`. |

Tool arguments never accept `SMTP_PASS`, `GMAIL_ACCESS_TOKEN`, or `AMT_API_KEY`.

## Tools

Banned on every tool: `htmlBody`, `textBody`, and the same fields under `html_body` / `text_body`. They are not input properties. Passing them returns an error and does not mint or send.

| Tool | Effect |
| --- | --- |
| `mint_tracked_message` | `POST /v1/messages`. Returns `message_id`, `pixel_url`, and `raw.mime_bytes` / `raw.has_open_pixel`. Set `include_raw` to also get `raw_mime` and `raw_base64url`. Does not send. |
| `send_tracked_email` | Mints when `raw_mime` / `raw_base64url` are omitted, then sends. `via` is `smtp` or `gmail_raw` (default follows which env is set). `from` is required (`AMT_FROM` is the fallback). |
| `get_tracked_message` | `GET /v1/messages/:id` — `status`, `opens`, `clicks`, events. |
| `mint_tracked_batch` | Mint-only rows or CSV via `client/batch`. Does not send. Map `email`→`to`, `body_text`→`text`. Optional `touch` `E1` \| `E2` \| `E3`. |

`send_tracked_email` with `raw_mime` or `raw_base64url` from an earlier mint does not mint a second message. Pass `message_id` so the result still names that row.

`plain_only` has no open pixel (`opens` is `null`). Default mode is `plain_looking`.

## After send

Poll `get_tracked_message`. The first fetch of `/o/:token` is an open. Do not paste AMT `html` into a connector compose call.
