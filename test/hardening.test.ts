import { afterEach, describe, expect, it, vi } from "vitest";
import { signToken, verifyToken } from "../src/tokens";
import { fireWebhook, isAllowedWebhookUrl, webhookPayload } from "../src/webhook";
import type { MessageRow } from "../src/types";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("tracking tokens", () => {
  it("accepts a matching HMAC and rejects kind swap, tamper, and oversized input", async () => {
    const token = await signToken("o", "msg_abc", "test-secret");
    expect(await verifyToken("o", token, "test-secret")).toBe("msg_abc");
    expect(await verifyToken("c", token, "test-secret")).toBeNull();
    expect(await verifyToken("o", `${token}x`, "test-secret")).toBeNull();
    expect(await verifyToken("o", "a".repeat(513), "test-secret")).toBeNull();
    expect(await verifyToken("o", token, "other-secret")).toBeNull();
  });
});

describe("webhook URL allowlist", () => {
  it("allows public https and http loopback only", () => {
    expect(isAllowedWebhookUrl("https://hooks.example.com/mail")).toBe(true);
    expect(isAllowedWebhookUrl("http://127.0.0.1:8787/hook")).toBe(true);
    expect(isAllowedWebhookUrl("http://localhost:8787/hook")).toBe(true);
    expect(isAllowedWebhookUrl("https://8.8.8.8/hook")).toBe(true);
  });

  it("rejects private, link-local, metadata, userinfo, and mapped IPv6", () => {
    expect(isAllowedWebhookUrl("https://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isAllowedWebhookUrl("https://metadata.google.internal/computeMetadata/v1/")).toBe(false);
    expect(isAllowedWebhookUrl("https://10.1.2.3/hook")).toBe(false);
    expect(isAllowedWebhookUrl("https://192.168.1.9/hook")).toBe(false);
    expect(isAllowedWebhookUrl("https://127.0.0.1/hook")).toBe(false);
    expect(isAllowedWebhookUrl("http://2130706433/hook")).toBe(true);
    expect(isAllowedWebhookUrl("https://2130706433/hook")).toBe(false);
    expect(isAllowedWebhookUrl("https://[::ffff:169.254.169.254]/")).toBe(false);
    expect(isAllowedWebhookUrl("https://user:pass@hooks.example/hook")).toBe(false);
    expect(isAllowedWebhookUrl("javascript:alert(1)")).toBe(false);
  });
});

describe("fireWebhook", () => {
  it("POSTs JSON and does not follow redirects", async () => {
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: { body?: unknown; method?: string; redirect?: string }) => {
      bodies.push(String(init?.body ?? ""));
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const message = {
      id: "msg_1",
      recipient: "ada@example.com",
      subject: "Hello",
    } as MessageRow;
    await fireWebhook(
      "https://hooks.example/mail",
      webhookPayload("first_open", message, "human_likely", "high_confidence_open", "2026-09-23T00:00:00.000Z"),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(bodies[0]).toContain("msg_1");
  });
});
