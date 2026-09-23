/** ASCII control chars. URL parsers strip some of these and glue the host together. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/**
 * Open-redirect safety: only http(s) destinations are allowed.
 * Rejects javascript:, data:, mailto:, tel:, file:, protocol-relative, userinfo,
 * and control characters. Backslash is allowed here because WHATWG turns `\` into `/`;
 * callers that redirect must use {@link canonicalRedirectHref}, not the raw string.
 */
export function isSafeRedirectUrl(url: string): boolean {
  return canonicalRedirectHref(url) !== null;
}

/**
 * Normalized href for a click Location, or null when the URL is not a safe http(s) target.
 * Drops userinfo and uses the parsed href so a raw `\` or odd encoding cannot pick a different host.
 */
export function canonicalRedirectHref(url: string): string | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed || trimmed.startsWith("//")) return null;
  if (CONTROL_CHARS.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    if (!parsed.hostname) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

export function shouldRewriteLink(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith("mailto:") ||
    lower.startsWith("tel:") ||
    lower.startsWith("#") ||
    lower.startsWith("javascript:") ||
    lower.startsWith("data:") ||
    lower.startsWith("cid:")
  ) {
    return false;
  }
  return isSafeRedirectUrl(trimmed);
}
