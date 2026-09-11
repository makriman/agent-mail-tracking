/**
 * Open-redirect safety: only http(s) destinations are allowed.
 * Rejects javascript:, data:, mailto:, tel:, file:, protocol-relative, and junk.
 */
export function isSafeRedirectUrl(url: string): boolean {
  if (typeof url !== "string") return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  // Protocol-relative URLs parse only with a base; refuse them outright.
  if (trimmed.startsWith("//")) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
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
