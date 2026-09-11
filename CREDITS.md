# Credits

Agent Mail Track is an independent implementation. Inspiration only — no code was copied from the projects below.

## Inspiration (ideas, not source)

- [pixel-tracker-vercel](https://github.com/anujarkitekt/pixel-tracker-vercel) — serverless 1×1 pixel + click redirect limited to `http`/`https`, optional webhooks, thin dashboard.
- [pixel-track](https://github.com/tinystrack/pixel-track) — self-hosted pixel, HMAC-style tokens, webhook on open, operator-owned data.
- [agent-analytics](https://github.com/Agent-Analytics/agent-analytics) — analytics shaped so an agent can read structured HTTP/CLI output and act, rather than living only in a human dashboard.

## Design-only, non-commercial reference

- [WhoReadMe](https://github.com/the-code-learner/WhoReadMe) — product/design reference for private, self-hosted email telemetry (signed pixels, click redirects, confidence-minded events). **Non-commercial license. Do not copy its code, configs, or proprietary heuristics.** Agent Mail Track was written from scratch under MIT.

## Out of scope (intentionally not ported)

SMTP/Gmail send, Chrome extensions, MCP servers, Docker-first packaging, SaaS multi-tenant billing, and reply detection.
