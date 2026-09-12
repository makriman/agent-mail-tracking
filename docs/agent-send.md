# Agent send path (open tracking)

Open tracking is the product. It only works if the HTML **1×1 `<img src="{base}/o/{token}">`** survives into the MIME that the inbox actually fetches.

This Worker does **not** send mail. `POST /v1/messages` instruments content and returns a ready-to-send RFC822 payload.

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

Scope needed for the Gmail call: `https://www.googleapis.com/auth/gmail.send` (or a broader Gmail scope you already use). This repo never stores mailbox secrets.

## SMTP

Pipe `raw_mime` as the message DATA (already has headers and CRLF). Any hop that HTML-sanitizes will drop the pixel the same way `htmlBody` does.

## After send

Poll `GET /v1/messages/{message_id}`. First successful image fetch is an `open` (`GET /o/:token` → 1×1 GIF). Clicks are `GET /c/:token` → 302; useful, but secondary to opens.
