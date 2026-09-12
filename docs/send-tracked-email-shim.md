# Grok Bot shim: `sendTrackedEmail`

Office-side integration spec. **AMT instruments; it does not send.** The office shim must mint, then deliver the returned RFC822.

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
2. Send the instrumented payload on the path below.
3. Return AMT `message_id` plus the send result.

## Gmail path

1. Mint: `POST /v1/messages`.
2. Send: Gmail API `users.messages.send({ raw: <raw_base64url> })`.

**Never** pass AMT `html` / `text` to connector `htmlBody` / `textBody`. Those fields sanitize and **strip `<img>`**. The pixel never reaches the inbox; `GET /v1/messages/:id` stays `no_signal` even if the recipient reads the mail.

Same ban for drafts: `users.drafts.create({ message: { raw } })` only. No `htmlBody`.

## SMTP / iCloud path

1. Same mint: `POST /v1/messages`.
2. Send: SMTP `DATA` of `raw_mime` (already headers + CRLF). Example hop: `smtp.mail.me.com:587` (STARTTLS). Any hop that HTML-sanitizes drops the pixel the same way `htmlBody` does.

## Success

- Sent “Show original” / raw MIME contains `track.greatindiancompany.com/o/…` (or the `base_url` used at mint).
- After the recipient’s client fetches the image, `GET /v1/messages/:id` shows an open (`opens >= 1`).

## Blockers

- Gmail needs `gmail.send`-capable OAuth **and** a **raw-capable** connector (`{ raw }`). `htmlBody` is banned for tracked mail.
- No raw Gmail and no SMTP `DATA` → the office cannot deliver a surviving pixel. AMT will not send for you.

## See also

- [agent-send.md](./agent-send.md) — mint fields, Gmail raw curl/Python, SMTP
- [api.md](./api.md) — `POST /v1/messages` / `GET /v1/messages/:id`
