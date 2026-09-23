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
| `ip_hash` | HMAC-SHA256(`ip:{CF-Connecting-IP}`, `TOKEN_SECRET`) as base64url. Never raw IP. `X-Forwarded-For` is ignored. |
| `user_agent` | Truncated to 512 chars |
| `classification` | See below |
| `cf_country` | Cloudflare `CF-IPCountry` when present |
| `deduped` | `1` if same message + type + ip_hash + UA within 60 minutes |

Deduped events stay on the timeline (marked) but do not increment `open_count` / `click_count` and do not re-fire webhooks.

Open and click URLs are unauthenticated. Each IP may insert at most **8** rows per rolling hour for one token (the open token is the message; a click token is that link). The first hit from an IP on that token is always stored, and a different IP is a different bucket, so one client cannot use up another reader's first open or first click. If `first_open_at` or `first_click_at` is still empty, that signal is written even when the bucket is already full. Further hits from the capped IP still return the GIF or the redirect and do not insert. No schema migration. Many source IPs can still insert 8 rows each per hour for that token and fill D1. See [SECURITY-D1.md](./SECURITY-D1.md).

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

If `webhook_url` was set at create time, the Worker fire-and-forgets a POST on the **first** non-deduped open and the **first** non-deduped click. Failures are swallowed. Timeout is 5 seconds. The URL must be public `https`, or `http` to `localhost` / `127.0.0.1` for local dev. Private, link-local, metadata, and IPv6 literal hosts are rejected. Redirects are not followed. A public hostname is checked twice with DNS-over-HTTPS immediately before the POST. The POST is skipped when an answer is non-public or has TTL 0. A lookup error or an empty answer still POSTs unless `WEBHOOK_DNS_FAIL_CLOSED` is set. Optional `WEBHOOK_HOST_ALLOWLIST` and `WEBHOOKS_DISABLED` are operator knobs. Workers still cannot pin the connect address; see [SECURITY-WEBHOOK.md](./SECURITY-WEBHOOK.md).

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

`type` is `first_open` or `first_click`. Public https is required (`http://localhost` and `http://127.0.0.1` are allowed for local tests).

## Pixel and redirect

- Open tracking is a standard 1×1 `<img>` whose `src` is `GET /o/:token`. That endpoint always returns a 1×1 GIF (`image/gif`) with `Cache-Control: no-store`. Invalid tokens still return the GIF so clients do not show a broken image.
- CSS / `background-image` / font-loading “pixels” are unreliable in Gmail and other clients. This Worker does not emit them.
- The `<img>` must be present in the **sent** MIME. Gmail connector `htmlBody` strips images; send `raw_mime` / `raw_base64url` instead ([agent-send.md](./agent-send.md)).
- `GET /c/:token` 302s to the stored original URL only if it is `http:` or `https:`. Other schemes are rejected (`invalid_destination`). Protocol-relative and relative URLs are refused at both instrument and redirect time. Click rewriting is secondary to open tracking.
