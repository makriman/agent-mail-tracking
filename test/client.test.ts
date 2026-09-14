import { afterEach, describe, expect, it, vi } from "vitest";
import { HTML_BODY_BANNED, assertNoHtmlBody } from "../client/guard";
import { shapeGmailRawSend, GMAIL_SEND_SCOPE, gmailSendUrl } from "../client/gmail";
import { mintTrackedMessage, shapeMintRequest, trimBaseUrl } from "../client/mint";
import { AmtClientError } from "../client/types";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("shapeMintRequest", () => {
  it("POSTs /v1/messages on a trimmed base URL with Bearer auth", () => {
    const req = shapeMintRequest({
      baseUrl: "https://track.greatindiancompany.com/",
      apiKey: "k-test",
      to: "ada@example.com",
      subject: "Hello",
      text: "Hi Ada,\n\nSee https://example.com/docs",
    });
    expect(req.url).toBe("https://track.greatindiancompany.com/v1/messages");
    expect(req.headers).toEqual({
      Authorization: "Bearer k-test",
      "Content-Type": "application/json",
    });
    expect(req.body).toEqual({
      to: "ada@example.com",
      subject: "Hello",
      text: "Hi Ada,\n\nSee https://example.com/docs",
    });
    expect(req.body).not.toHaveProperty("htmlBody");
    expect(req.body).not.toHaveProperty("textBody");
    expect(req.body).not.toHaveProperty("from");
  });

  it("always includes from when provided", () => {
    const req = shapeMintRequest({
      baseUrl: "https://track.greatindiancompany.com",
      apiKey: "k",
      to: "ada@example.com",
      from: "makriman@icloud.com",
      text: "Hi",
    });
    expect(req.body.from).toBe("makriman@icloud.com");
  });

  it("forwards optional html, mode, metadata, webhook, and tracking base_url", () => {
    const req = shapeMintRequest({
      baseUrl: "http://127.0.0.1:8787",
      apiKey: "k",
      to: "ada@example.com",
      html: "<p>Hi</p>",
      mode: "html",
      metadata: { agent: "unit" },
      webhookUrl: "https://hooks.example.com/mail",
      trackingBaseUrl: "https://track.greatindiancompany.com",
    });
    expect(req.url).toBe("http://127.0.0.1:8787/v1/messages");
    expect(req.body).toEqual({
      to: "ada@example.com",
      html: "<p>Hi</p>",
      mode: "html",
      metadata: { agent: "unit" },
      webhook_url: "https://hooks.example.com/mail",
      base_url: "https://track.greatindiancompany.com",
    });
    expect(Object.keys(req.body)).not.toContain("htmlBody");
  });

  it("rejects htmlBody on the mint options object", () => {
    expect(() =>
      shapeMintRequest({
        baseUrl: "https://track.example",
        apiKey: "k",
        to: "ada@example.com",
        text: "Hi",
        htmlBody: "<p>nope</p>",
      } as never),
    ).toThrow(HTML_BODY_BANNED);
  });
});

describe("mintTrackedMessage (mock fetch)", () => {
  const minted = {
    message_id: "msg_test",
    mode: "plain_looking",
    open_tracking: true,
    opens: 0,
    clicks: 0,
    status: "no_signal",
    to: "ada@example.com",
    from: "you@icloud.com",
    subject: "Hello",
    text: "Hi",
    html: '<p>Hi</p>\n<img src="https://track.example/o/tok" width="1" height="1" alt="">',
    raw_mime: "MIME-Version: 1.0\r\nFrom: you@icloud.com\r\n<img src=\"https://track.example/o/tok\">",
    raw_base64url: "TUlNRS1WZXJzaW9uOiAxLjA",
    pixel_url: "https://track.example/o/tok",
    base_url: "https://track.greatindiancompany.com",
    links: [],
    created_at: "2026-09-14T00:00:00.000Z",
  };

  it("sends the shaped JSON body and returns the 201 payload", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://track.greatindiancompany.com/v1/messages");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      expect(body.from).toBe("you@icloud.com");
      expect(body).not.toHaveProperty("htmlBody");
      return new Response(JSON.stringify(minted), { status: 201, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await mintTrackedMessage({
      baseUrl: "https://track.greatindiancompany.com/",
      apiKey: "secret",
      to: "ada@example.com",
      from: "you@icloud.com",
      subject: "Hello",
      text: "Hi Ada",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.message_id).toBe("msg_test");
    expect(result.raw_mime).toContain("/o/");
    expect(result.raw_base64url).toBe(minted.raw_base64url);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://track.greatindiancompany.com/v1/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          to: "ada@example.com",
          from: "you@icloud.com",
          subject: "Hello",
          text: "Hi Ada",
        }),
      }),
    );
  });

  it("does not hit the network and surfaces API errors", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "invalid_from" }), { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      mintTrackedMessage({
        baseUrl: "https://example.invalid",
        apiKey: "k",
        to: "ada@example.com",
        text: "Hi",
      }),
    ).rejects.toBeInstanceOf(AmtClientError);

    expect(fetchMock).toHaveBeenCalledWith("https://example.invalid/v1/messages", expect.anything());
  });
});

describe("htmlBody guard", () => {
  it("throws on htmlBody and textBody", () => {
    expect(() => assertNoHtmlBody({ htmlBody: "<p>x</p>" })).toThrow(/htmlBody is banned/);
    expect(() => assertNoHtmlBody({ textBody: "x" })).toThrow(/htmlBody is banned/);
    expect(() => assertNoHtmlBody({ html: "<p>ok</p>" })).not.toThrow();
  });
});

describe("gmail raw shaping", () => {
  it("sends { raw } to users.messages.send, never htmlBody", () => {
    const req = shapeGmailRawSend("QUJD", "ya29.token");
    expect(req.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages.send");
    expect(gmailSendUrl()).toBe(req.url);
    expect(req.body).toEqual({ raw: "QUJD" });
    expect(req.body).not.toHaveProperty("htmlBody");
    expect(GMAIL_SEND_SCOPE).toBe("https://www.googleapis.com/auth/gmail.send");
  });
});

describe("trimBaseUrl", () => {
  it("strips trailing slashes", () => {
    expect(trimBaseUrl("https://track.example///")).toBe("https://track.example");
  });
});
