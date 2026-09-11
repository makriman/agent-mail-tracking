// Bindings for Agent Mail Track. `npm run types` may regenerate a similar file.
// Secrets API_KEY and TOKEN_SECRET are set with `wrangler secret put`, not wrangler.jsonc.

interface Env {
  DB: D1Database;
  API_KEY: string;
  TOKEN_SECRET: string;
}
