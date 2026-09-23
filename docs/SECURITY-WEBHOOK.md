# Webhook delivery and DNS rebinding

DRAFT notes for operators. This does not change live Worker secrets.

Webhooks are server-side `POST`s fired on the first stored open and the first stored click. The URL is chosen by whoever holds `API_KEY`. The fetch runs on Cloudflare Workers.

## What delivery does

- Store and fetch only a canonical `https` URL, or `http` to `localhost` / `127.0.0.1` for local dev.
- Reject userinfo, control characters, private and link-local addresses, metadata names, and IPv6 URL literals.
- Send `redirect: "error"` so a 3xx cannot retarget the `POST`.
- For a hostname, resolve `A` and `AAAA` through DNS-over-HTTPS (`https://cloudflare-dns.com/dns-query`) **twice**, back to back, and skip the `POST` if either answer contains a non-public address.
- Skip the `POST` when an answer's TTL is `0` or negative. That is the usual rebinding signal, because resolvers are not supposed to cache it. A missing TTL is not treated as `0`.
- A lookup error or an empty answer still `POST`s, unless `WEBHOOK_DNS_FAIL_CLOSED` is set.

`POST /v1/messages` rejects a JSON body larger than 512 KiB (`Content-Length` when present, and the bytes actually read).

## Residual: Workers cannot pin the connect address

The Workers `fetch` used for the webhook has no parameter that binds the TCP connection to the addresses returned by the DoH check. After both checks return public addresses, the runtime resolves the name again on its own.

`cloudflare:sockets` can dial an IP, but that dial is not a hostname-pinned HTTPS client: certificate checks stay tied to the dial target. This repo does not ship a custom TLS stack, and it does not fall back from a failed pin to ordinary `fetch`. A fallback like that would fail open while looking like a fix.

### Attack sketch

1. A caller who can set `webhook_url` points it at a hostname they control.
2. Both DoH checks receive only public addresses, each with a positive TTL.
3. The Worker's own resolver, which this code cannot pin, then receives a private, link-local, or metadata address for the same name.
4. The `POST` body (recipient, subject, message id, classification) is sent to that address.

TTL `0` is the common way to make step 3 happen immediately. Those answers are denied. What remains is a positive TTL that expires between the second check and connect, or a split view where DoH and the edge resolver disagree. Two lookups against `cloudflare-dns.com` cannot prove they share a cache with the fetch path.

## Operator controls

Set these in the Worker environment (for local dev, `.dev.vars`). They are plain config, not substitutes for `API_KEY` or `TOKEN_SECRET`. Unset means the historical default.

| Variable | Unset | When set |
| --- | --- | --- |
| `WEBHOOK_HOST_ALLOWLIST` | Any host that passes the public-https checks | Comma-separated hostnames. Create and delivery both require an exact host match (`hooks.example.com` does not allow `evil.hooks.example.com`). Include `127.0.0.1` or `localhost` if local `http` hooks must keep working. |
| `WEBHOOKS_DISABLED` | Webhooks deliver | `1`, `true`, `yes`, or `on`. Delivery does not run. Create rejects a body that still includes `webhook_url` (`webhooks_disabled`). |
| `WEBHOOK_DNS_FAIL_CLOSED` | DNS errors and empty answers still `POST` | Same truthy values. Those results skip the `POST`. A DoH outage then drops webhooks. |

Further controls that do not need a code change:

- Do not mint `webhook_url` values for names you do not operate.
- Prefer a webhook hostname with TTL of at least 60 seconds.
- Private and metadata destinations are already rejected at create time.

## Related lows fixed with this note

- Open and click tokens compare with `safeEqual` and reject input longer than 512 characters.
- SMTP `MAIL FROM` / `RCPT TO` reject CR/LF before parsing and accept a single addr-spec. `EHLO` strips controls and whitespace.
- The dashboard message list uses the same human-open query as `GET /v1/messages`, so a later proxy hit cannot leave the HTML list on `proxy_open` while JSON stays `high_confidence_open`.
