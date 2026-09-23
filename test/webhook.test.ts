import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageRow } from "../src/types";
import {
  canonicalWebhookUrl,
  fireWebhook,
  isAllowedWebhookUrl,
  isBlockedAddress,
  parseWebhookHostAllowlist,
  resolveWebhookHost,
  webhookAddressesAllowed,
  webhookDeliveryFromEnv,
  webhookDnsDecision,
  webhookDnsTtlDenied,
  webhookHostAllowed,
  webhookPayload,
} from "../src/webhook";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("webhook URL allowlist", () => {
  it("allows public https and http loopback only", () => {
    expect(isAllowedWebhookUrl("https://hooks.example.com/mail")).toBe(true);
    expect(isAllowedWebhookUrl("http://127.0.0.1:8787/hook")).toBe(true);
    expect(isAllowedWebhookUrl("http://localhost:8787/hook")).toBe(true);
    expect(isAllowedWebhookUrl("https://8.8.8.8/hook")).toBe(true);
    expect(canonicalWebhookUrl("https://hooks.example.com/mail")).toBe("https://hooks.example.com/mail");
  });

  it("rejects private, link-local, metadata, userinfo, and mapped IPv6", () => {
    expect(isAllowedWebhookUrl("https://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isAllowedWebhookUrl("https://metadata.google.internal/computeMetadata/v1/")).toBe(false);
    expect(isAllowedWebhookUrl("https://10.1.2.3/hook")).toBe(false);
    expect(isAllowedWebhookUrl("https://192.168.1.9/hook")).toBe(false);
    expect(isAllowedWebhookUrl("https://172.16.0.5/hook")).toBe(false);
    expect(isAllowedWebhookUrl("https://100.100.100.200/latest")).toBe(false);
    expect(isAllowedWebhookUrl("https://127.0.0.1/hook")).toBe(false);
    expect(isAllowedWebhookUrl("https://0/hook")).toBe(false);
    expect(isAllowedWebhookUrl("http://10.1.2.3/hook")).toBe(false);
    expect(isAllowedWebhookUrl("http://2130706433/hook")).toBe(true);
    expect(isAllowedWebhookUrl("https://2130706433/hook")).toBe(false);
    expect(isAllowedWebhookUrl("https://0x7f000001/hook")).toBe(false);
    expect(isAllowedWebhookUrl("https://[::ffff:169.254.169.254]/")).toBe(false);
    expect(isAllowedWebhookUrl("https://[::1]/")).toBe(false);
    expect(isAllowedWebhookUrl("https://[2606:4700::1]/")).toBe(false);
    expect(isAllowedWebhookUrl("https://user:pass@hooks.example/hook")).toBe(false);
    expect(isAllowedWebhookUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedWebhookUrl("http://evil.example/hook")).toBe(false);
  });
});

describe("webhook address policy", () => {
  it("blocks private, mapped, transition, and documentation answers", () => {
    expect(isBlockedAddress("8.8.8.8")).toBe(false);
    expect(isBlockedAddress("10.1.2.3")).toBe(true);
    expect(isBlockedAddress("169.254.169.254")).toBe(true);
    expect(isBlockedAddress("0.0.0.0")).toBe(true);
    expect(isBlockedAddress("::1")).toBe(true);
    expect(isBlockedAddress("fe80::1")).toBe(true);
    expect(isBlockedAddress("fc00::1")).toBe(true);
    expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
    expect(isBlockedAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isBlockedAddress("::ffff:8.8.8.8")).toBe(false);
    expect(isBlockedAddress("64:ff9b::10.1.2.3")).toBe(true);
    expect(isBlockedAddress("2002:0a01:0203::")).toBe(true);
    expect(isBlockedAddress("2001:db8::1")).toBe(true);
    expect(webhookAddressesAllowed(["8.8.8.8", "10.0.0.1"])).toBe(false);
    expect(webhookAddressesAllowed([])).toBe(false);
    expect(webhookAddressesAllowed(["8.8.8.8"])).toBe(true);
    expect(webhookDnsDecision(["8.8.8.8"])).toBe("allow");
    expect(webhookDnsDecision(["10.0.0.1"])).toBe("deny");
    expect(webhookDnsDecision([])).toBe("unknown");
    expect(webhookDnsDecision(null)).toBe("unknown");
    expect(webhookDnsTtlDenied(0)).toBe(true);
    expect(webhookDnsTtlDenied(60)).toBe(false);
    expect(webhookDnsTtlDenied(undefined)).toBe(false);
  });
});

describe("resolveWebhookHost", () => {
  it("returns public answers and fails closed when any address is private", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const parsed = new URL(String(url));
      expect(parsed.hostname).toBe("cloudflare-dns.com");
      expect(init?.redirect).toBe("error");
      const type = parsed.searchParams.get("type");
      const data = type === "A" ? "8.8.8.8" : "2606:4700:4700::1111";
      const qtype = type === "A" ? 1 : 28;
      return new Response(JSON.stringify({ Status: 0, Answer: [{ type: qtype, data }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(resolveWebhookHost("hooks.example")).resolves.toBe("allow");

    fetchMock.mockImplementation(async (url: string) => {
      const type = new URL(String(url)).searchParams.get("type");
      if (type === "AAAA") {
        return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 28, data: "10.0.0.1" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: "1.2.3.4" }] }), { status: 200 });
    });
    await expect(resolveWebhookHost("rebind.example")).resolves.toBe("deny");

    fetchMock.mockImplementation(async () => new Response("nope", { status: 503 }));
    await expect(resolveWebhookHost("hooks.example")).resolves.toBe("unknown");

    fetchMock.mockImplementation(async (url: string) => {
      const type = new URL(String(url)).searchParams.get("type");
      const qtype = type === "A" ? 1 : 28;
      const data = type === "A" ? "8.8.8.8" : "2606:4700:4700::1111";
      return new Response(JSON.stringify({ Status: 0, Answer: [{ type: qtype, TTL: 0, data }] }), { status: 200 });
    });
    await expect(resolveWebhookHost("ttl0.example")).resolves.toBe("deny");
  });
});

describe("fireWebhook", () => {
  const message = {
    id: "msg_1",
    recipient: "ada@example.com",
    subject: "Hello",
  } as MessageRow;

  it("POSTs JSON to a public name and does not follow redirects", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await fireWebhook(
      "https://hooks.example/mail",
      webhookPayload("first_open", message, "human_likely", "high_confidence_open", "2026-09-23T00:00:00.000Z"),
      async () => "allow",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://hooks.example/mail");
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toContain("msg_1");
  });

  it("does not fetch when DNS returns a private address or the URL is already blocked", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const payload = webhookPayload("first_click", message, "unknown", "clicked", "2026-09-23T00:00:00.000Z");
    await fireWebhook("https://hooks.example/mail", payload, async () => "deny");
    await fireWebhook("https://169.254.169.254/latest/meta-data", payload, async () => {
      throw new Error("resolver must not run");
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still POSTs when DNS is inconclusive so a lookup failure does not drop a real webhook", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await fireWebhook(
      "https://hooks.example/mail",
      webhookPayload("first_open", message, "unknown", "proxy_open", "2026-09-23T00:00:00.000Z"),
      async () => "unknown",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fetches http loopback without a DNS lookup", async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await fireWebhook(
      "http://127.0.0.1:8787/hook",
      webhookPayload("first_open", message, "unknown", "proxy_open", "2026-09-23T00:00:00.000Z"),
      async () => {
        throw new Error("resolver must not run");
      },
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://127.0.0.1:8787/hook");
  });

  it("checks DNS twice and skips the POST when the second answer is private", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const decisions = ["allow", "deny"] as const;
    let i = 0;
    await fireWebhook(
      "https://hooks.example/mail",
      webhookPayload("first_open", message, "unknown", "proxy_open", "2026-09-23T00:00:00.000Z"),
      async () => decisions[i++] ?? "deny",
    );
    expect(i).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips an inconclusive lookup when fail-closed is set", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const payload = webhookPayload("first_open", message, "unknown", "proxy_open", "2026-09-23T00:00:00.000Z");
    await fireWebhook("https://hooks.example/mail", payload, async () => "unknown", { dnsFailClosed: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fetch when webhooks are disabled or the host is off the allowlist", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const payload = webhookPayload("first_open", message, "unknown", "proxy_open", "2026-09-23T00:00:00.000Z");
    await fireWebhook("https://hooks.example/mail", payload, async () => {
      throw new Error("resolver must not run");
    }, { disabled: true });
    await fireWebhook("https://hooks.example/mail", payload, async () => {
      throw new Error("resolver must not run");
    }, { hostAllowlist: ["hooks.other.example"] });
    await fireWebhook(
      "https://hooks.example/mail",
      payload,
      async () => "allow",
      { hostAllowlist: ["hooks.example"] },
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(parseWebhookHostAllowlist(" Hooks.Example., ")).toEqual(["hooks.example"]);
    expect(parseWebhookHostAllowlist("  ,  ")).toBeUndefined();
    expect(webhookHostAllowed("https://hooks.example/mail", ["hooks.example"])).toBe(true);
    expect(webhookDeliveryFromEnv({ WEBHOOKS_DISABLED: "yes", WEBHOOK_DNS_FAIL_CLOSED: "0" })).toEqual({
      disabled: true,
      dnsFailClosed: false,
      hostAllowlist: undefined,
    });
  });
});
