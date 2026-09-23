import type { Classification, MessageRow, Status } from "./types";

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const DOH_URL = "https://cloudflare-dns.com/dns-query";

/**
 * Public https webhooks, plus http loopback for local dev.
 * Rejects userinfo, control characters, private/link-local/metadata hosts, and IPv6 URL literals
 * (those hide v4-mapped addresses). Returns the parsed href, or null when the URL must not be stored or fetched.
 */
export function canonicalWebhookUrl(url: string): string | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed || trimmed.length > 2048 || trimmed.startsWith("//")) return null;
  if (CONTROL_CHARS.test(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password) return null;
  const host = normalizeHost(parsed.hostname);
  if (!host) return null;
  if (parsed.protocol === "http:") {
    if (host !== "localhost" && host !== "127.0.0.1") return null;
    return parsed.href;
  }
  if (parsed.protocol !== "https:") return null;
  if (isBlockedWebhookHost(host)) return null;
  return parsed.href;
}

export function isAllowedWebhookUrl(url: string): boolean {
  return canonicalWebhookUrl(url) !== null;
}

/** Addresses from DNS that are safe webhook targets. Empty is not a positive allow. */
export function webhookAddressesAllowed(ips: readonly string[]): boolean {
  return ips.length > 0 && ips.every((ip) => !isBlockedAddress(ip));
}

/** `deny` skips the POST. `unknown` (lookup error or no answers) still POSTs unless `dnsFailClosed` is set. */
export type WebhookDnsDecision = "allow" | "deny" | "unknown";

/**
 * Operator knobs. Defaults preserve delivery: DNS errors still POST, and any public https host is allowed.
 * These do not pin the Workers fetch to a resolved address.
 */
export interface WebhookDeliveryOptions {
  disabled?: boolean;
  dnsFailClosed?: boolean;
  hostAllowlist?: readonly string[];
}

export function webhookDnsDecision(ips: readonly string[] | null): WebhookDnsDecision {
  if (!ips || ips.length === 0) return "unknown";
  return ips.some((ip) => isBlockedAddress(ip)) ? "deny" : "allow";
}

export type WebhookHostResolver = (host: string) => Promise<WebhookDnsDecision>;

/**
 * Explicit TTL 0 (or negative) is the usual DNS-rebinding signal: resolvers must not cache it.
 * A missing TTL is not treated as 0. Cloudflare's JSON API includes TTL on each answer.
 * Skipping the POST when that field is absent would drop webhooks on a resolver that omits it.
 */
export function webhookDnsTtlDenied(ttl: number | undefined): boolean {
  return typeof ttl === "number" && ttl <= 0;
}

/**
 * Resolve A and AAAA via DNS-over-HTTPS.
 * Deny when an answer is non-public or has TTL <= 0. Errors and empty answers are `unknown`.
 * This does not pin the address Workers `fetch` will connect to.
 */
export async function resolveWebhookHost(host: string): Promise<WebhookDnsDecision> {
  const a = await lookupDoh(host, "A");
  if (a.status === "blocked") return "deny";
  if (a.status === "unknown") return "unknown";
  const aaaa = await lookupDoh(host, "AAAA");
  if (aaaa.status === "blocked") return "deny";
  if (aaaa.status === "unknown") return "unknown";
  return webhookDnsDecision([...a.ips, ...aaaa.ips]);
}

export function parseWebhookHostAllowlist(raw: string | undefined | null): readonly string[] | undefined {
  if (raw == null) return undefined;
  const hosts = raw
    .split(",")
    .map((part) => normalizeHost(part.trim()))
    .filter((part) => part.length > 0);
  return hosts.length > 0 ? hosts : undefined;
}

export function webhookDeliveryFromEnv(env: {
  WEBHOOKS_DISABLED?: string;
  WEBHOOK_DNS_FAIL_CLOSED?: string;
  WEBHOOK_HOST_ALLOWLIST?: string;
}): WebhookDeliveryOptions {
  return {
    disabled: envFlag(env.WEBHOOKS_DISABLED),
    dnsFailClosed: envFlag(env.WEBHOOK_DNS_FAIL_CLOSED),
    hostAllowlist: parseWebhookHostAllowlist(env.WEBHOOK_HOST_ALLOWLIST),
  };
}

export function webhookHostAllowed(url: string, allowlist: readonly string[] | undefined): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  const host = webhookDnsHost(url);
  if (!host) return false;
  return allowlist.some((entry) => normalizeHost(entry) === host);
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
  resolveHost: WebhookHostResolver = resolveWebhookHost,
  options: WebhookDeliveryOptions = {},
): Promise<void> {
  const target = canonicalWebhookUrl(webhookUrl);
  if (!target) return;
  if (options.disabled) return;
  if (!webhookHostAllowed(target, options.hostAllowlist)) return;
  const host = webhookDnsHost(target);
  if (host && hostNeedsDns(host)) {
    // Two lookups, back to back. The second one runs immediately before POST so a name that
    // flips to a private address between checks is skipped. This is not a connect-IP pin:
    // Workers fetch resolves DNS on its own after we return.
    const first = await lookupDecision(host, resolveHost);
    if (skipWebhookForDns(first, options.dnsFailClosed)) return;
    const second = await lookupDecision(host, resolveHost);
    if (skipWebhookForDns(second, options.dnsFailClosed)) return;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    await fetch(target, {
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

function envFlag(value: string | undefined): boolean {
  if (!value) return false;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

async function lookupDecision(host: string, resolveHost: WebhookHostResolver): Promise<WebhookDnsDecision> {
  try {
    return await resolveHost(host);
  } catch {
    return "unknown";
  }
}

function skipWebhookForDns(decision: WebhookDnsDecision, failClosed: boolean | undefined): boolean {
  if (decision === "deny") return true;
  return decision === "unknown" && Boolean(failClosed);
}

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
}

function isBlockedWebhookHost(host: string): boolean {
  const h = normalizeHost(host);
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "metadata.google.internal" || h.endsWith(".google.internal") || h === "metadata.goog") return true;
  if (h.endsWith(".internal") || h.endsWith(".local")) return true;
  if (h.includes(":")) return true;
  if (/^\d+$/.test(h) || /^0x[0-9a-f]+$/i.test(h)) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return isBlockedIpv4(h);
  return false;
}

function webhookDnsHost(url: string): string | null {
  try {
    const host = normalizeHost(new URL(url).hostname);
    return host || null;
  } catch {
    return null;
  }
}

function hostNeedsDns(host: string): boolean {
  const h = normalizeHost(host);
  if (h === "localhost" || h === "127.0.0.1") return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":")) return false;
  return true;
}

/** True when this address must not be a webhook target. Unparseable input is blocked. */
export function isBlockedAddress(ip: string): boolean {
  const raw = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!raw) return true;
  if (raw.includes(":")) return isBlockedIpv6(raw);
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(raw)) return true;
  return isBlockedIpv4(raw);
}

function isBlockedIpv4(host: string): boolean {
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return true;
  const octets = match.slice(1).map((part) => Number(part));
  if (octets.some((n) => n > 255)) return true;
  const [a, b] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function isBlockedIpv6(ip: string): boolean {
  const parts = expandIpv6(ip);
  if (!parts) return true;
  const joined = parts.join(":");
  if (joined === "0000:0000:0000:0000:0000:0000:0000:0000") return true;
  if (joined === "0000:0000:0000:0000:0000:0000:0000:0001") return true;
  if (parts.slice(0, 5).every((part) => part === "0000") && parts[5] === "ffff") {
    return isBlockedIpv4(ipv4FromHextets(parts[6]!, parts[7]!));
  }
  const first = Number.parseInt(parts[0]!, 16);
  if (first >= 0xfe80 && first <= 0xfebf) return true;
  if (first >= 0xfc00 && first <= 0xfdff) return true;
  if (first >= 0xff00) return true;
  if (parts[0] === "2002" && isBlockedIpv4(ipv4FromHextets(parts[1]!, parts[2]!))) return true;
  if (
    parts[0] === "0064" &&
    parts[1] === "ff9b" &&
    parts.slice(2, 6).every((part) => part === "0000") &&
    isBlockedIpv4(ipv4FromHextets(parts[6]!, parts[7]!))
  ) {
    return true;
  }
  if (parts[0] === "2001" && parts[1] === "0db8") return true;
  return false;
}

function ipv4FromHextets(hi: string, lo: string): string {
  const high = Number.parseInt(hi, 16);
  const low = Number.parseInt(lo, 16);
  return `${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`;
}

function expandIpv6(ip: string): string[] | null {
  let value = ip.toLowerCase();
  const dotted = value.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const octets = dotted[2]!.split(".").map((part) => Number(part));
    if (octets.length !== 4 || octets.some((n) => n > 255)) return null;
    const hi = ((octets[0]! << 8) | octets[1]!).toString(16);
    const lo = ((octets[2]! << 8) | octets[3]!).toString(16);
    value = `${dotted[1]}${hi}:${lo}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 0) return null;
  const parts = [...left, ...Array(missing).fill("0"), ...right];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return parts.map((part) => part.padStart(4, "0"));
}

async function lookupDoh(
  host: string,
  type: "A" | "AAAA",
): Promise<{ status: "ok"; ips: string[] } | { status: "blocked" } | { status: "unknown" }> {
  const qtype = type === "A" ? 1 : 28;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2000);
  try {
    const res = await fetch(`${DOH_URL}?name=${encodeURIComponent(host)}&type=${type}`, {
      headers: { Accept: "application/dns-json" },
      redirect: "error",
      signal: ctrl.signal,
    });
    if (!res.ok) return { status: "unknown" };
    const body = (await res.json()) as {
      Status?: number;
      Answer?: { type?: number; TTL?: number; data?: string }[];
    };
    if (body.Status !== 0) return { status: "unknown" };
    const ips: string[] = [];
    for (const answer of body.Answer ?? []) {
      if (answer.type !== qtype || typeof answer.data !== "string") continue;
      if (webhookDnsTtlDenied(answer.TTL) || isBlockedAddress(answer.data)) return { status: "blocked" };
      ips.push(answer.data);
    }
    return { status: "ok", ips };
  } catch {
    return { status: "unknown" };
  } finally {
    clearTimeout(timer);
  }
}
