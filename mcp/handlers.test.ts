import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { HTML_BODY_BANNED } from "../client/guard";
import type { SendTrackedEmailOptions } from "../client/send";
import type { GmailAuth, MintedMessage, MintTrackedMessageOptions, SmtpSendOptions } from "../client/types";
import { parseBatchArgs, parseMintArgs, parseSendArgs, rejectBannedConnectorFields } from "./args";
import { OPEN_TRACKING_INSTRUCTION } from "./copy";
import { loadAmtMcpConfig, loadHttpBind } from "./config";
import {
  getTrackedMessageTool,
  mintTrackedBatchTool,
  mintTrackedMessageTool,
  sendTrackedEmailTool,
  type AmtToolDeps,
} from "./handlers";
import type { AmtMcpConfig } from "./config";
import { utf8FromBase64Url, utf8ToBase64Url } from "./raw";

const minted: MintedMessage = {
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
  raw_mime: 'From: you@icloud.com\r\n<img src="https://track.example/o/tok">',
  raw_base64url: "TUlNRS1WZXJzaW9u",
  pixel_url: "https://track.example/o/tok",
  base_url: "https://track.example",
  links: [],
  created_at: "2026-09-22T00:00:00.000Z",
};

function config(over: Partial<AmtMcpConfig> = {}): AmtMcpConfig {
  return {
    baseUrl: "https://track.example",
    apiKey: "k-test",
    smtp: { host: "smtp.example", port: 587, user: "you@icloud.com", pass: "secret-pass", secure: false },
    ...over,
  };
}

function deps(partial: Partial<AmtToolDeps> = {}): AmtToolDeps {
  const unexpected = async () => {
    throw new Error("unexpected outbound call");
  };
  return {
    mintTrackedMessage: unexpected as AmtToolDeps["mintTrackedMessage"],
    sendTrackedEmail: unexpected as AmtToolDeps["sendTrackedEmail"],
    getTrackedMessage: unexpected as AmtToolDeps["getTrackedMessage"],
    sendRawMimeSmtp: unexpected as AmtToolDeps["sendRawMimeSmtp"],
    sendRawGmail: unexpected as AmtToolDeps["sendRawGmail"],
    runBatch: unexpected as AmtToolDeps["runBatch"],
    sleep: async () => {},
    ...partial,
  };
}

describe("loadAmtMcpConfig", () => {
  it("requires AMT_API_KEY and defaults the base URL", () => {
    expect(() => loadAmtMcpConfig({})).toThrow(/AMT_API_KEY/);
    const loaded = loadAmtMcpConfig({ AMT_API_KEY: "k" });
    expect(loaded.baseUrl).toBe("https://track.greatindiancompany.com");
    expect(loaded.smtp).toBeUndefined();
    expect(loaded.gmailAccessToken).toBeUndefined();
  });

  it("loads SMTP together and treats port 465 as implicit TLS", () => {
    expect(() => loadAmtMcpConfig({ AMT_API_KEY: "k", SMTP_HOST: "smtp.example" })).toThrow(/SMTP_HOST/);
    const loaded = loadAmtMcpConfig({
      AMT_API_KEY: "k",
      AMT_BASE_URL: "https://track.example/",
      AMT_FROM: "you@icloud.com",
      SMTP_HOST: "smtp.mail.me.com",
      SMTP_PORT: "465",
      SMTP_USER: "you@icloud.com",
      SMTP_PASS: "app-pass",
    });
    expect(loaded.baseUrl).toBe("https://track.example");
    expect(loaded.defaultFrom).toBe("you@icloud.com");
    expect(loaded.smtp).toEqual({
      host: "smtp.mail.me.com",
      port: 465,
      user: "you@icloud.com",
      pass: "app-pass",
      secure: true,
    });
  });

  it("honors SMTP_SECURE and binds HTTP to localhost", () => {
    const loaded = loadAmtMcpConfig({
      AMT_API_KEY: "k",
      SMTP_HOST: "smtp.example",
      SMTP_USER: "you@icloud.com",
      SMTP_PASS: "p",
      SMTP_SECURE: "true",
      GMAIL_ACCESS_TOKEN: "ya29.test",
    });
    expect(loaded.smtp?.secure).toBe(true);
    expect(loaded.smtp?.port).toBe(587);
    expect(loaded.gmailAccessToken).toBe("ya29.test");
    expect(loadHttpBind({})).toEqual({ host: "127.0.0.1", port: 3333 });
    expect(loadHttpBind({ AMT_MCP_HTTP_TOKEN: "tok", AMT_MCP_HTTP_PORT: "8788" })).toEqual({
      host: "127.0.0.1",
      port: 8788,
      token: "tok",
    });
    expect(() => loadHttpBind({ AMT_MCP_HTTP_PORT: "0" })).toThrow(/AMT_MCP_HTTP_PORT/);
  });
});

describe("mint argument validation", () => {
  it("rejects connector htmlBody and textBody", () => {
    expect(() => rejectBannedConnectorFields({ htmlBody: "<p>x</p>" })).toThrow(HTML_BODY_BANNED);
    expect(() => parseMintArgs({ to: "ada@example.com", text: "Hi", textBody: "Hi" })).toThrow(HTML_BODY_BANNED);
    expect(() => parseMintArgs({ to: "ada@example.com", text: "Hi", html_body: "<p>x</p>" })).toThrow(/banned/);
    expect(() => parseMintArgs({ to: "ada@example.com", text: "Hi", HtmlBody: "<p>x</p>" })).toThrow(/banned/);
  });

  it("requires an email and prose unless mode is html", () => {
    expect(() => parseMintArgs({ to: "not-an-email", text: "Hi" })).toThrow(/to must be an email/);
    expect(() => parseMintArgs({ to: "ada@example.com" })).toThrow(/text is required/);
    expect(() => parseMintArgs({ to: "ada@example.com", mode: "html" })).toThrow(/html is required/);
    expect(() => parseMintArgs({ to: "ada@example.com", text: "Hi", mode: "nope" })).toThrow(/invalid mode/);
    const args = parseMintArgs({ to: "ada@example.com", text: "Hi", from: "you@icloud.com" });
    expect(args.includeRaw).toBe(false);
    expect(args.from).toBe("you@icloud.com");
  });
});

describe("mintTrackedMessageTool", () => {
  it("returns a summary and does not dump raw MIME unless asked", async () => {
    const mint = vi.fn(async (_opts: MintTrackedMessageOptions) => minted);
    const summary = await mintTrackedMessageTool(
      { to: "ada@example.com", from: "you@icloud.com", subject: "Hello", text: "Hi Ada" },
      config(),
      deps({ mintTrackedMessage: mint }),
    );
    expect(mint).toHaveBeenCalledOnce();
    expect(mint.mock.calls[0]?.[0]).toMatchObject({
      baseUrl: "https://track.example",
      apiKey: "k-test",
      to: "ada@example.com",
      from: "you@icloud.com",
      text: "Hi Ada",
    });
    expect(mint.mock.calls[0]?.[0]).not.toHaveProperty("htmlBody");
    expect(summary.message_id).toBe("msg_test");
    expect(summary.pixel_url).toBe("https://track.example/o/tok");
    expect(summary.raw.has_open_pixel).toBe(true);
    expect(summary.raw.mime_bytes).toBe(minted.raw_mime.length);
    expect(summary).not.toHaveProperty("raw_mime");
    expect(summary).not.toHaveProperty("raw_base64url");
    expect(JSON.stringify(summary)).not.toContain("k-test");
  });

  it("includes raw MIME only when include_raw is set", async () => {
    const mint = vi.fn(async (_opts: MintTrackedMessageOptions) => minted);
    const summary = await mintTrackedMessageTool(
      { to: "ada@example.com", text: "Hi", include_raw: true },
      config(),
      deps({ mintTrackedMessage: mint }),
    );
    expect(summary.raw_mime).toContain("/o/");
    expect(summary.raw_base64url).toBe(minted.raw_base64url);
  });
});

describe("sendTrackedEmailTool", () => {
  it("requires from and refuses to run without transport env", async () => {
    await expect(
      sendTrackedEmailTool({ to: "ada@example.com", text: "Hi", via: "smtp" }, config({ defaultFrom: undefined })),
    ).rejects.toThrow(/from must be an email/);
    await expect(
      sendTrackedEmailTool(
        { to: "ada@example.com", from: "you@icloud.com", text: "Hi", via: "smtp" },
        config({ smtp: undefined }),
        deps(),
      ),
    ).rejects.toThrow(/SMTP_HOST/);
    await expect(
      sendTrackedEmailTool(
        { to: "ada@example.com", from: "you@gmail.com", text: "Hi", via: "gmail_raw" },
        config({ gmailAccessToken: undefined }),
        deps(),
      ),
    ).rejects.toThrow(/GMAIL_ACCESS_TOKEN/);
  });

  it("mints then sends SMTP DATA and keeps the password out of the result", async () => {
    const sendTrackedEmail = vi.fn(async (_opts: SendTrackedEmailOptions) => ({
      minted,
      via: "smtp" as const,
      smtp: { accepted: true as const, code: 250, response: "250 ok" },
    }));
    const result = await sendTrackedEmailTool(
      { to: "ada@example.com", text: "Hi Ada", via: "smtp" },
      config({ defaultFrom: "you@icloud.com" }),
      deps({ sendTrackedEmail }),
    );
    expect(sendTrackedEmail).toHaveBeenCalledOnce();
    const opts = sendTrackedEmail.mock.calls[0]?.[0];
    expect(opts).toMatchObject({
      via: "smtp",
      from: "you@icloud.com",
      to: "ada@example.com",
      smtp: { host: "smtp.example", pass: "secret-pass" },
    });
    expect(opts).not.toHaveProperty("htmlBody");
    expect(opts).not.toHaveProperty("gmail");
    expect(result.minted).toBe(true);
    expect(result.message_id).toBe("msg_test");
    expect(result.pixel_url).toContain("/o/");
    expect(result.smtp).toEqual({ accepted: true, response: "250 ok" });
    expect(result).not.toHaveProperty("raw_mime");
    expect(JSON.stringify(result)).not.toContain("secret-pass");
  });

  it("sends an existing raw MIME without minting again", async () => {
    const sendRawMimeSmtp = vi.fn(async (_opts: SmtpSendOptions) => ({ accepted: true as const, code: 250, response: "250 queued" }));
    const sendTrackedEmail = vi.fn(async (_opts: SendTrackedEmailOptions) => {
      throw new Error("should not mint");
    });
    const result = await sendTrackedEmailTool(
      {
        to: "ada@example.com",
        from: "you@icloud.com",
        via: "smtp",
        message_id: "msg_test",
        raw_mime: minted.raw_mime,
      },
      config(),
      deps({ sendRawMimeSmtp, sendTrackedEmail }),
    );
    expect(sendTrackedEmail).not.toHaveBeenCalled();
    expect(sendRawMimeSmtp).toHaveBeenCalledOnce();
    expect(sendRawMimeSmtp.mock.calls[0]?.[0]).toMatchObject({
      from: "you@icloud.com",
      to: "ada@example.com",
      rawMime: minted.raw_mime,
    });
    expect(result.minted).toBe(false);
    expect(result.message_id).toBe("msg_test");
    expect(result.raw?.has_open_pixel).toBe(true);
  });

  it("sends Gmail API {raw} and never an html body", async () => {
    const sendRawGmail = vi.fn(async (_auth: GmailAuth, _raw: string) => ({ id: "gmsg", threadId: "thr" }));
    const result = await sendTrackedEmailTool(
      {
        to: "ada@example.com",
        from: "you@gmail.com",
        via: "gmail_raw",
        raw_base64url: minted.raw_base64url,
      },
      config({ gmailAccessToken: "ya29.test" }),
      deps({ sendRawGmail }),
    );
    expect(sendRawGmail).toHaveBeenCalledWith({ accessToken: "ya29.test" }, minted.raw_base64url);
    expect(sendRawGmail.mock.calls[0]?.[1]).not.toMatch(/htmlBody/);
    expect(result.gmail).toEqual({ id: "gmsg", threadId: "thr" });
    expect(JSON.stringify(result)).not.toContain("ya29.test");
  });

  it("defaults via from env", () => {
    expect(parseSendArgs({ to: "ada@example.com", from: "you@icloud.com", text: "Hi" }, config()).via).toBe("smtp");
    expect(
      parseSendArgs(
        { to: "ada@example.com", from: "you@gmail.com", text: "Hi" },
        config({ smtp: undefined, gmailAccessToken: "ya29.test" }),
      ).via,
    ).toBe("gmail_raw");
  });
});

describe("getTrackedMessageTool", () => {
  it("returns opens, clicks, and status", async () => {
    const getTrackedMessage = vi.fn(async () => ({
      message_id: "msg_test",
      to: "ada@example.com",
      subject: "Hello",
      mode: "plain_looking",
      open_tracking: true,
      opens: 1,
      clicks: 0,
      status: "high_confidence_open",
    }));
    const view = await getTrackedMessageTool({ message_id: "msg_test" }, config(), deps({ getTrackedMessage }));
    expect(getTrackedMessage).toHaveBeenCalledWith({
      baseUrl: "https://track.example",
      apiKey: "k-test",
      messageId: "msg_test",
    });
    expect(view.opens).toBe(1);
    expect(view.status).toBe("high_confidence_open");
  });

  it("rejects a missing id", async () => {
    await expect(getTrackedMessageTool({}, config(), deps())).rejects.toThrow(/message_id/);
  });
});

describe("mintTrackedBatchTool", () => {
  it("mints CSV rows and does not send", async () => {
    const { runBatch } = await import("../client/batch");
    const mintTrackedMessage = vi.fn(async (opts: { to: string }) => ({
      ...minted,
      message_id: `msg_${opts.to.split("@")[0]}`,
      to: opts.to,
      pixel_url: `https://track.example/o/${opts.to}`,
    }));
    const csv = [
      "email,subject,body_text",
      "ada@lab.edu,Hello,Hi Ada",
      "bea@lab.edu,Hello,Hi Bea",
    ].join("\n");
    const result = await mintTrackedBatchTool(
      { csv, from: "you@icloud.com", touch: "E1", delay_ms: 0, campaign: "wave" },
      config(),
      deps({ mintTrackedMessage, runBatch, sleep: async () => {} }),
    );
    expect(mintTrackedMessage).toHaveBeenCalledTimes(2);
    expect(result.mint_only).toBe(true);
    expect(result.summary).toEqual({ total: 2, minted: 2, sent: 0, error: 0 });
    expect(result.rows.map((row) => row.amt_message_id)).toEqual(["msg_ada", "msg_bea"]);
    expect(result.rows[0]?.pixel_url).toContain("/o/");
    expect(result.csv).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("secret-pass");
  });

  it("rejects connector fields and empty batches", () => {
    expect(() =>
      parseBatchArgs({ rows: [{ email: "ada@lab.edu", body_text: "Hi", htmlBody: "<img>" }], from: "you@icloud.com" }, config()),
    ).toThrow(/banned/);
    expect(() => parseBatchArgs({ from: "you@icloud.com" }, config())).toThrow(/csv or rows/);
    expect(() => parseBatchArgs({ csv: "email,body_text\n", from: "you@icloud.com" }, config())).toThrow(/no rows/);
  });
});

describe("docs contract", () => {
  it("README tells agents to call send_tracked_email", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain(OPEN_TRACKING_INSTRUCTION);
  });
});

describe("raw base64url", () => {
  it("round-trips UTF-8", () => {
    const raw = 'Hello\r\n<img src="https://track.example/o/tok">';
    expect(utf8FromBase64Url(utf8ToBase64Url(raw))).toBe(raw);
  });
});
