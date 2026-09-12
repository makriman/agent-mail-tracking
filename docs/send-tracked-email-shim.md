# Office shim: `sendTrackedEmail`

Provider-agnostic mint+send for any agent office (Grok Bot / xAI first; ChatGPT, Claude, Outlook MCP, …). **AMT instruments; it does not send.** It does not replace Gmail or Outlook.

Same pattern everywhere: mint → send via that provider’s raw / Graph MIME / SMTP path that **preserves HTML `<img>`**.

## Why AMT (not a connector patch)

Upstream connectors often sanitize `htmlBody` (or JSON HTML `body.content`) and **strip `<img>`**, or they expose no raw send. That is an industry class — Gmail MCP `send_message` / `create_draft`, Outlook MCP compose, and similar tools. Chrome MailTrack-class extensions never see API sends. Waiting on vendor sanitizer fixes is not a product.

AMT mints instrumented RFC822 (`raw_mime` / `raw_base64url`) with the 1×1 pixel intact. The office wraps send. Outlook Graph send MIME is **first-class next** (same mint; not connected in this Worker yet).

## Goal

Every agent outbound message is tracked. Agents call `sendTrackedEmail` only. They must **not** `POST /v1/messages` themselves or treat tracking as an opt-in.

## Defaults

| Setting | Value |
| --- | --- |
| Tracking | **on** |
| AMT `mode` | `plain_looking` |
| Opt-out | `track: false` only |

`track` is a **shim** flag. AMT has no `track` field. `track: false` skips mint and sends the caller’s original content untracked.

## Contract

```
sendTrackedEmail({
  to,                 // required
  from?, subject?,
  text?, html?,       // same rules as POST /v1/messages
  track?: true,       // default on; false = skip AMT
  mode?: "plain_looking"  // AMT mode when tracking; default plain_looking
})
```

When `track` is on (default):

1. `POST /v1/messages` with `mode=plain_looking` (unless the caller passed another AMT mode).
2. Send the instrumented payload on a path below.
3. Return AMT `message_id` plus the send result.

## Send paths (keep `<img>`)

| Provider | Use | Banned |
| --- | --- | --- |
| **Gmail** | `users.messages.send({ raw: <raw_base64url> })` (drafts: `users.drafts.create({ message: { raw } })`) | `htmlBody` / `textBody` |
| **Outlook** (next) | Graph send MIME — `POST /me/sendMail` with `Content-Type: text/plain` and `raw_mime` (not JSON `body.content`) | MCP / Graph JSON HTML body |
| **SMTP / iCloud** | SMTP `DATA` of `raw_mime` (e.g. `smtp.mail.me.com:587`, STARTTLS) | Any HTML-sanitizing hop |
| Future connectors | Same mint; wrap whatever raw/MIME/SMTP API keeps `<img>` | `htmlBody`-class fields |

**Never** pass AMT `html` / `text` to connector `htmlBody` / JSON HTML. Sanitizers drop `<img>`. The pixel never reaches the inbox; `GET /v1/messages/:id` stays `no_signal` even if the recipient reads the mail.

## Success

- Sent “Show original” / raw MIME contains `track.greatindiancompany.com/o/…` (or the `base_url` used at mint).
- After the recipient’s client fetches the image, `GET /v1/messages/:id` shows an open (`opens >= 1`).

## Blockers

- The office needs a **raw / MIME / SMTP-capable** send (Gmail `gmail.send` + `{ raw }`, Outlook Graph MIME, or SMTP `DATA`). `htmlBody`-class paths are banned for tracked mail.
- No such path → the office cannot deliver a surviving pixel. AMT will not send for you. Do not wait on upstream connector vendors to stop stripping `<img>`.

## See also

- [agent-send.md](./agent-send.md) — mint fields, Gmail raw curl/Python, SMTP
- [api.md](./api.md) — `POST /v1/messages` / `GET /v1/messages/:id`
