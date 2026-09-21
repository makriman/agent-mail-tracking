# Agent send path (open tracking)

Open tracking is the product. It only works if the HTML **1×1 `<img src="{base}/o/{token}">`** survives into the MIME that the inbox actually fetches.

This Worker does **not** send mail. `POST /v1/messages` instruments content and returns a ready-to-send RFC822 payload.

**Quickest working path:** in-repo Node client / CLI — mint, then SMTP `DATA` of `raw_mime` (iCloud `smtp.mail.me.com:587` is the proven path when `from` matches the mailbox). **Never** Gmail MCP `htmlBody`.

```ts
import { sendTrackedEmail } from "../client/index.ts";
await sendTrackedEmail({
  baseUrl: process.env.AMT_BASE_URL!, apiKey: process.env.AMT_API_KEY!,
  to: "ada@example.com", from: "you@icloud.com",
  subject: "Hello", text: "Hi Ada — see https://example.com/docs",
  via: "smtp", smtp: { host: "smtp.mail.me.com", port: 587, user: process.env.SMTP_USER!, pass: process.env.SMTP_PASS! },
});
```

```bash
export AMT_BASE_URL=https://track.greatindiancompany.com
export AMT_API_KEY=…          # Worker API_KEY; not a mailbox password
export SMTP_HOST=smtp.mail.me.com SMTP_PORT=587
export SMTP_USER=you@icloud.com SMTP_PASS=…   # app password; never commit
npm run send-tracked -- --to ada@example.com --from you@icloud.com --subject Hello --text "Hi Ada"
```

`client/` is the reference `sendTrackedEmail` implementation (mint always passes `from` when set; send is `smtp` | `gmail_raw` only). Spec: [send-tracked-email-shim.md](./send-tracked-email-shim.md). AMT is not Postal; see [compare-postal.md](./compare-postal.md).

## Do not use Gmail connector `htmlBody`

Gmail MCP / connector `send_message` and `create_draft` fields named `htmlBody` (and typical “compose HTML” helpers) **sanitize and strip `<img>` tags**. Verified failure mode:

1. Agent posts to this API and gets `html` containing the pixel.
2. Agent sends that string via `htmlBody`.
3. Draft RAW and sent RAW have **no** `<img>`.
4. The recipient can clear UNREAD; `GET /v1/messages/:id` stays `status: "no_signal"`.

**Do not** use `htmlBody` / `textBody` for tracked mail.

CSS `background-image` and other “hidden pixel” tricks are unreliable across clients. This API keeps a standard 1×1 `<img>` as the only open beacon.

## Correct path

1. `POST /v1/messages` (default `mode` is `plain_looking`).
2. Take **`raw_base64url`** (or `raw_mime` for SMTP).
3. Send with the **Gmail API raw** field, or any SMTP `DATA` that does not rewrite HTML.

| Field | Type | Use |
| --- | --- | --- |
| `raw_mime` | string | RFC 5322 message (CRLF). SMTP `DATA`, debugging, “show original”. |
| `raw_base64url` | string | Gmail API `users.messages.send` and `users.drafts.create` `{ "raw": "<this>" }` (base64url, no padding). |

Typical `plain_looking` / `html` shape: `multipart/alternative` with `text/plain` + `text/html`. The HTML part includes the tracking `<img>` and click-rewritten `https` links.

`From` is included only if you passed `from` on create (must match the Gmail account or a send-as alias). If omitted, Gmail fills the authenticated user.

## Modes

| Mode | Open tracking | MIME |
| --- | --- | --- |
| `plain_looking` (default) | yes — count starts at `0` | multipart + pixel |
| `html` | yes | HTML (multipart if you also sent `text`) + pixel |
| `plain_only` | **no** — `opens` is `null`, never claim `0` | `text/plain` only |

## Curl: instrument then Gmail raw send

Replace placeholders. Do not commit tokens.

```bash
export HOST="https://track.greatindiancompany.com"   # or your workers.dev
export API_KEY="…"                                   # Worker API_KEY
export GMAIL_ACCESS_TOKEN="ya29.ACCESS_TOKEN_PLACEHOLDER"

RESP=$(curl -sS -X POST "$HOST/v1/messages" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "ada@example.com",
    "from": "you@gmail.com",
    "subject": "Hello",
    "text": "Hi Ada,\n\nSee https://example.com/docs and write back."
  }')

echo "$RESP" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("pixel", d.get("pixel_url")); print("img in mime", "/o/" in d["raw_mime"] and "<img" in d["raw_mime"])'
RAW=$(echo "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["raw_base64url"])')

# Gmail API raw — this path keeps the <img>
curl -sS -X POST "https://gmail.googleapis.com/gmail/v1/users/me/messages/send" \
  -H "Authorization: Bearer $GMAIL_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"raw\": \"$RAW\"}"
```

Confirm the sent message: Gmail “Show original” / `users.messages.get?format=raw` must still contain `<img src="…/o/…">`.

## Python: instrument then Gmail raw send

```python
import json
import os
import urllib.request

TRACK_HOST = os.environ["TRACK_HOST"]  # e.g. https://track.greatindiancompany.com
TRACK_API_KEY = os.environ["TRACK_API_KEY"]
GMAIL_ACCESS_TOKEN = os.environ.get("GMAIL_ACCESS_TOKEN", "ya29.ACCESS_TOKEN_PLACEHOLDER")

create_req = urllib.request.Request(
    f"{TRACK_HOST}/v1/messages",
    data=json.dumps({
        "to": "ada@example.com",
        "from": "you@gmail.com",
        "subject": "Hello",
        "text": "Hi Ada,\n\nSee https://example.com/docs and write back.",
    }).encode(),
    headers={
        "Authorization": f"Bearer {TRACK_API_KEY}",
        "Content-Type": "application/json",
    },
    method="POST",
)
created = json.load(urllib.request.urlopen(create_req))
assert created["html"] and "/o/" in created["html"]
assert "<img" in created["raw_mime"] and "/o/" in created["raw_mime"]

# Do NOT put created["html"] into Gmail htmlBody.
send_req = urllib.request.Request(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    data=json.dumps({"raw": created["raw_base64url"]}).encode(),
    headers={
        "Authorization": f"Bearer {GMAIL_ACCESS_TOKEN}",
        "Content-Type": "application/json",
    },
    method="POST",
)
print(json.load(urllib.request.urlopen(send_req)))
```

Scope needed for the Gmail call: `https://www.googleapis.com/auth/gmail.send` (or a broader Gmail scope you already use). This repo never stores mailbox secrets and does not ship an OAuth UI — pass `GMAIL_ACCESS_TOKEN` or a `googleauth` object with `getAccessToken()`.

```ts
import { sendTrackedEmail } from "../client/index.ts";
await sendTrackedEmail({
  baseUrl: process.env.AMT_BASE_URL!, apiKey: process.env.AMT_API_KEY!,
  to: "ada@example.com", from: "you@gmail.com",
  subject: "Hello", text: "Hi Ada",
  via: "gmail_raw", gmail: { accessToken: process.env.GMAIL_ACCESS_TOKEN! },
});
```

## SMTP

Pipe `raw_mime` as the message DATA (already has headers and CRLF). Any hop that HTML-sanitizes will drop the pixel the same way `htmlBody` does.

Reference: `sendRawMimeSmtp` / `sendTrackedEmail({ via: "smtp" })` in [`client/`](../client/index.ts). Pass `from` on mint so the RFC822 `From` matches the authenticated mailbox (required for iCloud). Prefer the client/CLI over hand-rolled `DATA`.

## After send

Poll `GET /v1/messages/{message_id}`. First successful image fetch is an `open` (`GET /o/:token` → 1×1 GIF). Clicks are `GET /c/:token` → 302; useful, but secondary to opens.

## Researcher GTM / batch wave prepare

eSlams Researcher GTM (prepare-only): mint AMT `amt_message_id`s onto the mailmerge sheet so opens can be joined later (Sheet sync is a follow-on). **`--mint-only` does not send.** Not an MTA. Never `htmlBody`. Bodies have **no URLs** — do not invent links; click tracking is N/A.

**Prepare MAILMERGE-E1 (no send):**

```bash
# Shared box path (not required for repo tests — tests use test/fixtures/mailmerge-e1.csv)
npm run send-tracked-batch -- \
  --csv /workspace/eslams-outbound-500/MAILMERGE-E1.csv \
  --out /workspace/eslams-outbound-500/AMT-LOG-E1.csv \
  --mint-only \
  --touch E1 \
  --campaign eslams-researcher-lowstakes-2026-09 \
  --from makriman@berkeley.edu
```

| Flag | Value |
| --- | --- |
| `--mint-only` | mint `POST /v1/messages` only; no SMTP/Gmail |
| `--touch` | `E1` \| `E2` \| `E3` |
| `--campaign` | default `eslams-researcher-lowstakes-2026-09` |
| `--from` / `AMT_FROM` | `makriman@berkeley.edu` |
| `--delay-ms` | default `1000`; row errors fail-soft |

**Mailmerge columns** (map: `email`→`to`, `body_text`→`text` with `mode=plain_looking`, `subject`→`subject`):

```csv
send_batch_order,contact_id,first_name,email,subject,body_text
1,c_ada,Ada,ada@lab.edu,Quick question on your preprint,"Hi Ada — I read your paper on low-stakes assessment. Would you have 20 minutes to compare notes?"
```

Log CSV **keeps input columns** and appends: `campaign`, `touch`, `amt_message_id`, `sent_at`, `open_status`, `open_at`, `bounce_or_error`. At prepare, `sent_at` / `open_status` / `open_at` are empty; mint/send failures go in `bounce_or_error` ( `amt_message_id` is still written if mint succeeded).

Optional `--raw-dir ./wave-raw` writes `<message_id>.eml`. Do not remint the same wave if those IDs must stay stable. To mint **and** send later (your mailbox, still not Postal): drop `--mint-only` and pass `--via smtp` or `--via gmail_raw`. Single-row CLI is unchanged (`npm run send-tracked`).

Programmatic: `runBatch` / `parseCsvRecords` in [`client/batch.ts`](../client/batch.ts). Never `htmlBody`. Never commit SMTP passwords or OAuth tokens.
