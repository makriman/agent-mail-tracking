# AMT vs Postal

**Postal** is a full **MTA** (mail transfer agent): you run it as send-through infrastructure. It accepts mail over HTTP/SMTP, queues it, signs DKIM, handles bounces, IP pools, and delivers to the public internet. Using Postal means Postal *is* your outbound mail server.

**AMT (this repo)** is a **mint+track bridge** for agents. `POST /v1/messages` instruments content and returns `raw_mime` / `raw_base64url` (open pixel + click rewrites). You send that payload with a mailbox you already have (iCloud/Gmail SMTP, Gmail API `{ raw }`, Outlook Graph MIME). The Worker never relays, queues, or delivers mail.

AMT will **not** become a Postal-style MTA. Do not fork Postal into this Worker, replace D1 tracking with Postal’s send pipeline, or add Docker mail-server ops here.

| | AMT | Postal |
| --- | --- | --- |
| Job | Instrument + record opens/clicks | Send and receive mail at scale |
| Sends mail? | No (reference `client/` uses *your* SMTP/Gmail) | Yes — that is the product |
| Pixel / click telemetry for agents | Yes (D1 JSON) | Not the product; you’d still need tracking |
| When to use | Agents must send from existing offices/mailboxes; connectors strip `htmlBody` `<img>` | You want to operate a mail platform (IPs, queues, webhooks for delivery/bounces) |

Use **both** only if you already run Postal *and* still want AMT pixels: mint here, then hand `raw_mime` to Postal’s send API as opaque RFC822 — same rule as Gmail raw / SMTP DATA. Do not paste AMT `html` into any `htmlBody`-class field.

See [agent-send.md](./agent-send.md) and [`client/`](../client/index.ts).
