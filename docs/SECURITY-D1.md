# Open and click writes and the multi-IP residual

DRAFT notes for operators. This does not change live Worker secrets, the schema, or the Worker.

`GET /o/:token` and `GET /c/:token` are unauthenticated. A hit that is allowed inserts one row in D1 `events`. Deduped rows are still inserted until the cap below; they stay on the timeline and do not increment `open_count` / `click_count`.

## What the cap does

Each source IP may insert at most **8** rows per rolling hour for one token.

| Piece | Rule |
| --- | --- |
| IP | HMAC-SHA256(`ip:{CF-Connecting-IP}`, `TOKEN_SECRET`), base64url. Raw IP is not stored. `X-Forwarded-For` is ignored, so a client cannot invent a new bucket. |
| Open token | The message. `link_id` is empty. |
| Click token | That link. A second link on the same message is a second bucket. |
| Window | Rolling 60 minutes, compared to `created_at` on existing rows. |
| Count | Every insert in the window, including `deduped = 1`. |

The first hit from an IP on that token is stored, because the count starts at zero. A different IP is a different bucket, so one client cannot use up another reader's first open or first click. If `first_open_at` or `first_click_at` is still empty, that one signal is written even when this IP's bucket is already full. After the signal exists, a full bucket does not insert. The GIF or the redirect is still returned.

A missing `CF-Connecting-IP` shares one empty hash. Those requests are one bucket, not one bucket per caller.

Same User-Agent, message, type, and IP hash inside the hour is marked `deduped`. A different User-Agent is a new counted row until the 8 inserts are used.

## Residual: many IPs can still fill D1

The cap is per IP and per token. It is not a database-wide cap, not a per-message cap across IPs, and not a lifetime cap. When the hour rolls, the same IP may insert 8 more rows for that token.

A pixel or click URL reached from many `CF-Connecting-IP` values can insert 8 rows per address per hour for that token. Distinct click links add their own 8. Opens and clicks do not share a bucket. `events` can grow with the number of addresses. One client, and one forged `X-Forwarded-For`, cannot do this. Rotating the edge IP can.

### Why a global cap is not the close

An earlier hourly and lifetime ceiling on the message could be spent before a later reader arrived, so that reader's first open or first click was never stored. The per-IP bucket keeps that first hit. Collapsing every address into one budget brings the same miss back. This note does not add that budget, a new table, or an env knob.

### What still gets through

1. An open or click URL leaves the recipient mailbox.
2. Requests arrive with many `CF-Connecting-IP` values.
3. Each address inserts up to 8 `events` rows per hour for that token. A new User-Agent on that address makes the row count toward `open_count` or `click_count`.
4. D1 grows with the address set. Past 8, that address still receives the GIF or the redirect, and no further row is inserted until the window moves.

## Operator controls

Nothing new to set. Unset means the cap above.

- Treat `/o/` and `/c/` URLs as bearer links. They belong in the sent message.
- Rotating `TOKEN_SECRET` invalidates outstanding open and click tokens. It also invalidates legitimate pixels still in flight, and it does not delete rows already stored.
- v0 has no purge job. Watch D1 size.
- A zone rule in front of `/o/` and `/c/` can bound total requests before they reach the Worker. This repo does not ship that rule. A per-IP ceiling there matches the app cap and leaves the many-IP residual. A total ceiling bounds the residual and can drop a later reader's first event once it is spent — the same tradeoff as a global row cap.
