# Security residuals (2026-09-23)

DRAFT index for operators. This note does not change live Worker secrets and does not deploy the Worker.

## Notes

- [SECURITY-WEBHOOK.md](./SECURITY-WEBHOOK.md) — webhook URL checks, DNS-over-HTTPS, operator knobs, and the Workers TCP pin residual.
- [SECURITY-D1.md](./SECURITY-D1.md) — open and click write cap, and the multi-IP D1 residual.

## Held

MCP PR #6 stays on founder HOLD. This stack leaves that work untouched.

## Residuals that remain

### Workers cannot pin TCP

Webhook delivery resolves the hostname twice through DNS-over-HTTPS, then the Worker `fetch`es the URL. The runtime has no parameter that binds that TCP connection to the addresses those checks returned. A positive TTL can expire between the second check and connect, and DNS-over-HTTPS can disagree with the edge resolver. Detail: [SECURITY-WEBHOOK.md](./SECURITY-WEBHOOK.md).

### Many IPs can still fill D1

`GET /o/:token` and `GET /c/:token` insert at most 8 rows per `CF-Connecting-IP` per token per rolling hour. A different address is a different bucket, so `events` can grow with the address set. Detail: [SECURITY-D1.md](./SECURITY-D1.md).

## Mint cap

`POST /v1/messages` is the only mint route. The batch CLI calls that route once per row. There is no separate batch route, so the same cap covers a wave.

v0 configures one `API_KEY`. Every successful mint counts toward that key. The counter is `messages` rows whose `created_at` falls in the last 60 minutes. The rows live in D1, so a new isolate keeps the same count.

| Piece | Rule |
| --- | --- |
| Bucket | The configured `API_KEY`. Callers who share the key share the budget. |
| Cap | **1000** successful mints per rolling hour (`MINT_WRITES_PER_KEY_PER_HOUR` in `src/db.ts`). |
| Under the cap | `201` body stays the same: `message_id`, instrumented `raw_mime` / `raw_base64url`, links. |
| At the cap | `429` `{ "error": "rate_limited" }` and `Retry-After` (seconds until the oldest row in the window ages out). The handler writes no `messages` row and no `links` row. |
| Other errors | `400` and `413` happen before the count. They leave the budget unchanged. |

1000 covers two documented 500-row mint-only waves in one hour (`--delay-ms 1000` on the batch CLI), with a small margin for retries. A third full wave in that hour waits for the window.

The read and the insert are two statements. Overlapping requests can each pass the read and each insert, so the stored count can land a few rows past 1000. A tight loop still stops in that band.

### What the mint cap leaves open

- Each allowed mint still writes one `messages` row and one `links` row per distinct `http(s)` URL in the body. Text and HTML are already limited to 256 KiB.
- When the hour rolls, the key may mint another 1000.
- Open and click inserts use the separate per-IP cap. Many source addresses can still grow `events`.
- Rotating `API_KEY` leaves stored rows in place. v0 does not record which key wrote a row, so the new secret keeps counting the hour's existing mints.
- A later multi-key deployment would share this one bucket until the counter is keyed by secret.
