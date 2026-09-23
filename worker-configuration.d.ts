// Bindings for Agent Mail Track. `npm run types` may regenerate a similar file.
// Secrets API_KEY and TOKEN_SECRET are set with `wrangler secret put`, not wrangler.jsonc.

interface Env {
  DB: D1Database;
  API_KEY: string;
  TOKEN_SECRET: string;
  /** `1` / `true` / `yes` / `on` skips every webhook POST. Unset delivers. */
  WEBHOOKS_DISABLED?: string;
  /** `1` / `true` / `yes` / `on` skips the POST when DNS-over-HTTPS errors or returns no addresses. Unset still POSTs. */
  WEBHOOK_DNS_FAIL_CLOSED?: string;
  /** Comma-separated hostnames. When set, only these webhook hosts are stored and fetched. */
  WEBHOOK_HOST_ALLOWLIST?: string;
}
