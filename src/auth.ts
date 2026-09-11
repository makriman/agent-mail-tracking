import type { Context, Next } from "hono";
import { safeEqual } from "./crypto";

type AppEnv = { Bindings: Env };

function configuredKey(c: Context<AppEnv>): string | null {
  const key = c.env.API_KEY;
  return key && key.length > 0 ? key : null;
}

export function extractApiKey(c: Context<AppEnv>): string | null {
  const header = c.req.header("Authorization") ?? "";
  const bearer = header.match(/^Bearer\s+(.+)$/i);
  if (bearer?.[1]) return bearer[1].trim();

  const basic = header.match(/^Basic\s+(.+)$/i);
  if (basic?.[1]) {
    try {
      const decoded = atob(basic[1]);
      const colon = decoded.indexOf(":");
      // username ignored; password is the API key (browser Basic prompt).
      return colon >= 0 ? decoded.slice(colon + 1) : decoded;
    } catch {
      return null;
    }
  }
  return null;
}

export function isAuthorized(c: Context<AppEnv>): boolean {
  const expected = configuredKey(c);
  if (!expected) return false;
  const provided = extractApiKey(c);
  if (!provided) return false;
  return safeEqual(provided, expected);
}

export async function requireApiKey(c: Context<AppEnv>, next: Next) {
  if (isAuthorized(c)) return next();

  const wantsHtml = (c.req.header("Accept") ?? "").includes("text/html") || isDashboardPath(c.req.path);
  if (wantsHtml) {
    return c.body("Authentication required", 401, {
      "WWW-Authenticate": 'Basic realm="Agent Mail Track"',
      "Content-Type": "text/plain; charset=utf-8",
    });
  }
  return c.json({ error: "unauthorized" }, 401, {
    "WWW-Authenticate": 'Bearer realm="Agent Mail Track"',
  });
}

function isDashboardPath(path: string): boolean {
  return path === "/" || path.startsWith("/m/");
}
