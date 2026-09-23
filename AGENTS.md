# Cloud Agents — Agent Mail Track

Pointer for the open 2026-09-23 hardening drafts. The longer Cloud Agent notes (build, test, send path) are on draft [PR #7](https://github.com/makriman/agent-mail-tracking/pull/7) (`cursor/review-2026-09-23-ce0f`). That file is not on this branch. This page only points at the operator docs that are.

Do not merge and do not deploy from a docs task. Merge is not deploy. Do not change live Worker secrets. Do not edit `mcp/`.

| Doc | What it is |
| --- | --- |
| [docs/HARDENING-STACK-2026-09-23.md](./docs/HARDENING-STACK-2026-09-23.md) | Draft chain: #7 review → #8 Medium → #9 webhook/DoH/lows → #10 D1 multi-IP docs. |
| [docs/SECURITY-WEBHOOK.md](./docs/SECURITY-WEBHOOK.md) | Webhook delivery and the DNS-rebinding residual. |
| [docs/SECURITY-D1.md](./docs/SECURITY-D1.md) | Open/click write cap and the multi-IP D1 fill residual. |

MCP [PR #6](https://github.com/makriman/agent-mail-tracking/pull/6) is HOLD. Jev floors are locked this pass.
