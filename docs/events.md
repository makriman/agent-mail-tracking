# Events, classification, and confidence

Tracking endpoints are public (email clients must be able to fetch them). They never accept mailbox credentials. Raw client IPs are **not** stored.

## Event types

| `type` | When | Endpoint |
| --- | --- | --- |
| `open` | HTML client loads the 1×1 pixel | `GET /o/:token` |
| `click` | Recipient follows a rewritten link | `GET /c/:token` |

`plain_only` messages never issue an open token. Their `opens` field is always `null` (not `0`). The Worker will not increment open counts for those rows.

Reply detection is a **future stub**. Every API payload includes `"replied": false`. v0 never emits status `replied`.

## Stored fields (`events` table)

| Column | Notes |
| --- | --- |
| `id` | `evt_…` |
| `message_id` | Parent message |
| `link_id` | Set on clicks; null on opens |
| `type` | `open` \| `click` |
| `created_at` | ISO-8601 UTC from the Worker |
| `ip_hash` | HMAC-SHA256(`ip:{ip}`, `TOKEN_SECRET`) as base64url. Never raw IP. |
| `user_agent` | Truncated to 512 chars |
| `classification` | See below |
| `cf_country` | Cloudflare `CF-IPCountry` when present |
| `deduped` | `1` if same message + type + ip_hash + UA within 60 minutes |

Deduped events stay on the timeline (marked) but do not increment `open_count` / `click_count` and do not re-fire webhooks.

## Classification (best-effort)

Email clients prefetch and proxy images. Treat labels as hints.

| Value | Heuristic (v0) |
| --- | --- |
| `gmail_proxy` | UA contains `GoogleImageProxy` or `ggpht.com` |
| `apple_mpp` | UA is exactly `Mozilla/5.0`, or contains `ApplePrivacy` / `privacy.apple` |
| `security_scanner` | Known scanner/gateway strings (Proofpoint, Mimecast, Barracuda, SafeLinks, …) or bot/crawler/spider/preview |
| `human_likely` | Full browser UA (Chrome / Firefox / Edge / Safari) that is not a known proxy |
| `unknown` | Empty UA or anything else |

Clicks use the same classifier. A scanner that pre-clicks a URL is still recorded as a `click` (status becomes `clicked`).

## Confidence hierarchy (`status`)

Exposed on every message object as `status`:

```
replied (future stub)
  > clicked
  > high_confidence_open     # at least one open classified human_likely
  > proxy_open               # opens exist, none human_likely (proxy / scanner / unknown)
  > no_signal
```

`plain_only` can only be `clicked` or `no_signal`. Never claim opens.

## Webhooks

If `webhook_url` was set at create time, the Worker fire-and-forgets a POST on the **first** non-deduped open and the **first** non-deduped click. Failures are swallowed. Timeout is 5 seconds.

```json
{
  "type": "first_open",
  "message_id": "msg_…",
  "to": "ada@example.com",
  "subject": "Hello",
  "status": "proxy_open",
  "classification": "gmail_proxy",
  "occurred_at": "2026-09-11T02:15:00.000Z"
}
```

`type` is `first_open` or `first_click`. HTTPS required (http://localhost is allowed for local tests).

## Pixel and redirect

- Open tracking is a standard 1×1 `<img>` whose `src` is `GET /o/:token`. That endpoint always returns a 1×1 GIF (`image/gif`) with `Cache-Control: no-store`. Invalid tokens still return the GIF so clients do not show a broken image.
- CSS / `background-image` / font-loading “pixels” are unreliable in Gmail and other clients. This Worker does not emit them.
- The `<img>` must be present in the **sent** MIME. Gmail connector `htmlBody` strips images; send `raw_mime` / `raw_base64url` instead ([agent-send.md](./agent-send.md)).
- `GET /c/:token` 302s to the stored original URL only if it is `http:` or `https:`. Other schemes are rejected (`invalid_destination`). Protocol-relative and relative URLs are refused at both instrument and redirect time. Click rewriting is secondary to open tracking.
