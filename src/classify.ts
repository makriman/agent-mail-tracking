import type { Classification } from "./types";

const SCANNER_NEEDLES = [
  "proofpoint",
  "mimecast",
  "barracuda",
  "ironport",
  "cisco-talos",
  "safelinks",
  "outlook-safelink",
  "protection.outlook",
  "fireeye",
  "symantec",
  "messagelabs",
  "forcepoint",
  "sophos",
  "spamassassin",
  "clamav",
  "cloudmark",
  "agari",
  "abnormal",
  "microsoft office",
  "security scanner",
  "urldefense",
];

/**
 * Best-effort UA classification. Email clients proxy images; treat this as a
 * hint, not identity. See docs/events.md.
 */
export function classifyOpen(userAgent: string | null | undefined): Classification {
  const ua = (userAgent ?? "").trim();
  if (!ua) return "unknown";
  const lower = ua.toLowerCase();

  if (lower.includes("googleimageproxy") || lower.includes("ggpht.com")) {
    return "gmail_proxy";
  }

  // Apple Mail Privacy Protection commonly presents a bare or near-bare Mozilla/5.0.
  if (
    lower.includes("appleprivacy") ||
    lower.includes("privacy.apple") ||
    ua === "Mozilla/5.0" ||
    /^mozilla\/5\.0$/i.test(ua)
  ) {
    return "apple_mpp";
  }

  if (SCANNER_NEEDLES.some((n) => lower.includes(n))) {
    return "security_scanner";
  }
  if (
    lower.includes("bot") ||
    lower.includes("crawler") ||
    lower.includes("spider") ||
    lower.includes("preview") ||
    lower.includes("scanner")
  ) {
    return "security_scanner";
  }

  if (
    /mozilla\/\d/i.test(ua) &&
    (lower.includes("chrome/") ||
      lower.includes("firefox/") ||
      lower.includes("edg/") ||
      lower.includes("safari/")) &&
    !lower.includes("googleimageproxy")
  ) {
    return "human_likely";
  }

  return "unknown";
}
