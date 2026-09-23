import { canonicalRedirectHref } from "./redirect";
import type { Classification, MessageRow, Status } from "./types";

/**
 * Webhooks are server-side fetches. Allow public https, plus http loopback for local dev.
 * Reject private, link-local, metadata, and every IPv6 literal (blocks ::ffff: mapped bypasses).
 */
export function isAllowedWebhookUrl(url: string): boolean {
  const href = canonicalRedirectHref(url);
  if (!href) return false;
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (parsed.protocol === "http:") {
    return host === "localhost" || host === "127.0.0.1";
  }
  if (parsed.protocol !== "https:") return false;
  return !isBlockedWebhookHost(host);
}

function isBlockedWebhookHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "metadata.google.internal" || host.endsWith(".google.internal")) return true;
  if (host.endsWith(".internal") || host.endsWith(".local")) return true;
  if (host.startsWith("[") || host.includes(":")) return true;
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return true;

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map((part) => Number(part));
  if (octets.some((n) => n > 255)) return true;
  const [a, b] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

export async function fireWebhook(
  webhookUrl: string,
  payload: {
    type: "first_open" | "first_click";
    message_id: string;
    to: string;
    subject: string | null;
    status: Status;
    classification: Classification;
    occurred_at: string;
  },
): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    await fetch(webhookUrl, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "agent-mail-track/0",
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch {
    // Fire-and-forget: webhook failures must not break tracking.
  } finally {
    clearTimeout(timer);
  }
}

export function webhookPayload(
  type: "first_open" | "first_click",
  message: MessageRow,
  classification: Classification,
  status: Status,
  occurred_at: string,
) {
  return {
    type,
    message_id: message.id,
    to: message.recipient,
    subject: message.subject,
    status,
    classification,
    occurred_at,
  };
}
