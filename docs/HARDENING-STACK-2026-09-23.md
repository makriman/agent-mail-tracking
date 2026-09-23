# Hardening stack — 2026-09-23

DRAFT map for operators. This file does not change the Worker, the schema, live secrets, or `mcp/`.

**Merge is not deploy.** A green merge of any draft below does not ship `agent-mail-track`. Deploy is a separate step (`npm run deploy` / remote D1 migrate) and is not part of this pass. Leave every PR in this list as a draft until the founder says otherwise.

**MCP PR #6 is HOLD.** [PR #6](https://github.com/makriman/agent-mail-tracking/pull/6) (`cursor/amt-mcp-bridge-292a`) stays founder-gated. Do not merge it, do not mark it ready, and do not edit `mcp/` from this chain.

**Jev floors are locked this pass.** This map does not raise or lower them, and it does not ship code that would.

## Read order

These are open drafts. #7 and #8 both start from `main` at `dde365e`. #8 does not merge #7. #9 stacks on #8. #10 stacks on #9. Read them in the order below. Do not treat a merge of one as a deploy of the rest.

| Order | PR | Branch | What it is |
| --- | --- | --- | --- |
| 1 | [#7](https://github.com/makriman/agent-mail-tracking/pull/7) | `cursor/review-2026-09-23-ce0f` | Security review of `main` plus a read of MCP #6. Findings in `docs/REVIEW-2026-09-23.md` on that branch. No Critical or High on `main`. Medium and Low called out. Some small hardenings live only there until #8 and #9 re-land them. |
| 2 | [#8](https://github.com/makriman/agent-mail-tracking/pull/8) | `cursor/medium-d1-ssrf-pixel-8cef` | Medium items from #7, reimplemented off `main` (does not merge the review branch). Open/click inserts capped at 8 rows per rolling hour per `CF-Connecting-IP` and per token. Webhook SSRF: public `https` (http loopback for local dev), private / link-local / metadata / IPv6 literals rejected, `redirect: "error"`, DNS-over-HTTPS skips the POST when an answer is non-public. Gmail `raw_base64url` must match `raw_mime` and still contain the `/o/` pixel unless `mode` is `plain_only`. A few lows: canonical click `Location`, `private, no-store`, dashboard `frame-ancestors 'none'`. |
| 3 | [#9](https://github.com/makriman/agent-mail-tracking/pull/9) | `cursor/wave2-rebinding-leftovers-e856` | On top of #8. Webhook hostnames are resolved twice immediately before the POST; a non-public answer or TTL `0` skips it. Optional knobs: `WEBHOOK_HOST_ALLOWLIST`, `WEBHOOKS_DISABLED`, `WEBHOOK_DNS_FAIL_CLOSED` (unset keeps the previous default). PR #7 lows #8 left alone: `safeEqual` and a 512-character token cap, SMTP envelope / EHLO, 512 KiB body cap, dashboard list status aligned with `GET /v1/messages`. Operator note: [SECURITY-WEBHOOK.md](./SECURITY-WEBHOOK.md). |
| 4 | [#10](https://github.com/makriman/agent-mail-tracking/pull/10) | `cursor/d1-multi-ip-fill-docs-3cd0` | Docs only, on top of #9. The 8-per-hour cap is per IP and per token. Many source IPs can still insert 8 rows each and fill D1. A global cap was not added, because it can drop a later reader's first open or first click. Operator note: [SECURITY-D1.md](./SECURITY-D1.md). |

This document sits on #10. It does not retarget those PRs.

## Still open after #10

- **Workers cannot pin the webhook TCP peer.** After both DNS-over-HTTPS checks succeed, the runtime resolves the name again. See [SECURITY-WEBHOOK.md](./SECURITY-WEBHOOK.md).
- **Many IPs can still fill D1.** See [SECURITY-D1.md](./SECURITY-D1.md).
- **Mint throttle is not on this branch.** `POST /v1/messages` still requires `API_KEY` and is not rate-limited here. A follow-up from the same base may add that cap. This PR does not include it and does not depend on it.
- **MCP #6** stays HOLD, off this chain.

## What this pass does not do

No Worker behavior change. No schema migration. No live secret read or write. No deploy. No edit under `mcp/`.
