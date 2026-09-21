import { afterEach, describe, expect, it, vi } from "vitest";
import { HTML_BODY_BANNED } from "../client/guard";
import {
  BATCH_USAGE,
  csvEscape,
  mergeHeaders,
  parseCsv,
  parseCsvRecords,
  parseDelayMs,
  RESULT_COLUMNS,
  runBatch,
  stringifyCsv,
  stringifyCsvRecords,
} from "../client/batch";
import { AmtClientError, type MintedMessage } from "../client/types";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mintedFixture(over: Partial<MintedMessage> = {}): MintedMessage {
  return {
    message_id: "msg_ada",
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
    raw_mime: 'MIME-Version: 1.0\r\nFrom: you@icloud.com\r\n<img src="https://track.example/o/tok">',
    raw_base64url: "TUlNRS1WZXJzaW9uOiAxLjA",
    pixel_url: "https://track.example/o/tok",
    base_url: "https://track.greatindiancompany.com",
    links: [],
    created_at: "2026-09-21T00:00:00.000Z",
    ...over,
  };
}

describe("CSV parse", () => {
  it("parses headers and quoted commas, quotes, and newlines", () => {
    const text = [
      "to,subject,text",
      `"ada@example.com","Quick, question","Hi Ada, see https://example.com/docs"`,
      `"bob@example.com","He said ""hi""","Line1\nLine2"`,
    ].join("\n");
    const { headers, records } = parseCsvRecords(text);
    expect(headers).toEqual(["to", "subject", "text"]);
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({
      to: "ada@example.com",
      subject: "Quick, question",
      text: "Hi Ada, see https://example.com/docs",
    });
    expect(records[1]?.subject).toBe('He said "hi"');
    expect(records[1]?.text).toBe("Line1\nLine2");
  });

  it("strips BOM, skips blank lines, and keeps extra columns", () => {
    const text = "\uFEFFto,subject,text,wave\n\nada@example.com,Hello,Hi,gtm-1\n\n";
    const { headers, records } = parseCsvRecords(text);
    expect(headers).toEqual(["to", "subject", "text", "wave"]);
    expect(records).toEqual([{ to: "ada@example.com", subject: "Hello", text: "Hi", wave: "gtm-1" }]);
  });

  it("round-trips via stringifyCsv", () => {
    const rows = [
      ["to", "text"],
      ["ada@example.com", 'Hi, "Ada"'],
    ];
    const csv = stringifyCsv(rows);
    expect(csvEscape('Hi, "Ada"')).toBe('"Hi, ""Ada"""');
    expect(parseCsv(csv)).toEqual(rows);
  });

  it("stringifyCsvRecords appends result columns without dropping extras", () => {
    const headers = mergeHeaders(["to", "wave"], RESULT_COLUMNS);
    const csv = stringifyCsvRecords(headers, [
      {
        to: "ada@example.com",
        wave: "gtm",
        message_id: "msg_1",
        pixel_url: "https://track.example/o/a",
        status: "minted",
        error: "",
        via: "",
        sent_at: "",
      },
    ]);
    const parsed = parseCsvRecords(csv);
    expect(parsed.headers).toEqual(["to", "wave", ...RESULT_COLUMNS]);
    expect(parsed.records[0]?.message_id).toBe("msg_1");
    expect(parsed.records[0]?.wave).toBe("gtm");
  });

  it("rejects unterminated quotes and duplicate headers", () => {
    expect(() => parseCsv('"nope')).toThrow(AmtClientError);
    expect(() => parseCsvRecords("to,to\nada@example.com,x")).toThrow(/duplicate header/);
  });
});

describe("parseDelayMs", () => {
  it("defaults to 1000 and accepts 0", () => {
    expect(parseDelayMs(undefined)).toBe(1000);
    expect(parseDelayMs("")).toBe(1000);
    expect(parseDelayMs("0")).toBe(0);
    expect(parseDelayMs("250")).toBe(250);
    expect(() => parseDelayMs("-1")).toThrow(/delay-ms/);
  });
});

describe("mint-only dry run (mocked fetch)", () => {
  it("mints every row, writes message_id, and never sends", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { to: string };
      const minted = mintedFixture({
        message_id: body.to.startsWith("ada") ? "msg_ada" : "msg_bob",
        to: body.to,
        pixel_url: `https://track.example/o/${body.to.startsWith("ada") ? "ada" : "bob"}`,
      });
      return new Response(JSON.stringify(minted), { status: 201, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const sendSmtp = vi.fn(async () => {
      throw new Error("smtp must not run in --mint-only");
    });
    const sendGmail = vi.fn(async () => {
      throw new Error("gmail must not run in --mint-only");
    });
    const sleepMock = vi.fn(async () => undefined);

    const input = parseCsvRecords(
      [
        "to,subject,text,from,mode,metadata_json",
        'ada@lab.edu,Quick question,"Hi Ada — see https://example.com/collab",you@icloud.com,plain_looking,"{""wave"":""gtm-2026-09""}"',
        "bob@lab.edu,Follow up,Hi Bob,you@icloud.com,plain_looking,",
      ].join("\n"),
    );

    const result = await runBatch({
      records: input.records,
      headers: input.headers,
      mintOnly: true,
      delayMs: 1000,
      baseUrl: "https://track.greatindiancompany.com/",
      apiKey: "k-test",
      via: "smtp",
      smtp: { host: "smtp.example", port: 587, user: "u", pass: "p" },
      deps: { sendSmtp, sendGmail, sleep: sleepMock, nowIso: () => "2026-09-21T12:00:00.000Z" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sendSmtp).not.toHaveBeenCalled();
    expect(sendGmail).not.toHaveBeenCalled();
    expect(sleepMock).toHaveBeenCalledTimes(1);
    expect(sleepMock).toHaveBeenCalledWith(1000);

    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(firstBody).toEqual({
      to: "ada@lab.edu",
      from: "you@icloud.com",
      subject: "Quick question",
      text: "Hi Ada — see https://example.com/collab",
      mode: "plain_looking",
      metadata: { wave: "gtm-2026-09" },
    });
    expect(firstBody).not.toHaveProperty("htmlBody");

    expect(result.summary).toEqual({ total: 2, minted: 2, sent: 0, error: 0 });
    expect(result.records.map((r) => r.status)).toEqual(["minted", "minted"]);
    expect(result.records[0]?.message_id).toBe("msg_ada");
    expect(result.records[0]?.pixel_url).toBe("https://track.example/o/ada");
    expect(result.records[0]?.via).toBe("");
    expect(result.records[0]?.sent_at).toBe("");
    expect(result.records[0]?.error).toBe("");
    expect(result.csv).toContain("message_id");
    expect(result.csv).toContain("msg_bob");
  });

  it("fail-soft continues after a bad row and still mints the rest", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { to: string };
      return new Response(JSON.stringify(mintedFixture({ message_id: "msg_ok", to: body.to })), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const input = parseCsvRecords(
      [
        "to,subject,text",
        "not-an-email,Skip me,Hi",
        "ada@example.com,Hello,Hi Ada",
        "bob@example.com,Hello,",
      ].join("\n"),
    );

    const result = await runBatch({
      records: input.records,
      headers: input.headers,
      mintOnly: true,
      delayMs: 0,
      baseUrl: "https://track.greatindiancompany.com",
      apiKey: "k",
    });

    expect(result.summary).toEqual({ total: 3, minted: 1, sent: 0, error: 2 });
    expect(result.records[0]?.status).toBe("error");
    expect(result.records[0]?.error).toMatch(/to must be an email/);
    expect(result.records[0]?.message_id).toBe("");
    expect(result.records[1]?.status).toBe("minted");
    expect(result.records[1]?.message_id).toBe("msg_ok");
    expect(result.records[2]?.status).toBe("error");
    expect(result.records[2]?.error).toMatch(/missing text/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not mint rows that carry htmlBody", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const input = parseCsvRecords("to,subject,text,htmlBody\nada@example.com,Hello,Hi,<p>nope</p>\n");
    const result = await runBatch({
      records: input.records,
      headers: input.headers,
      mintOnly: true,
      delayMs: 0,
      baseUrl: "https://track.example",
      apiKey: "k",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.records[0]?.status).toBe("error");
    expect(result.records[0]?.error).toBe(HTML_BODY_BANNED);
  });

  it("keeps message_id when mint works and send fails", async () => {
    const result = await runBatch({
      records: [{ to: "ada@example.com", subject: "Hi", text: "Hello" }],
      headers: ["to", "subject", "text"],
      mintOnly: false,
      via: "smtp",
      delayMs: 0,
      defaultFrom: "you@icloud.com",
      baseUrl: "https://track.example",
      apiKey: "k",
      smtp: { host: "smtp.example", port: 587, user: "u", pass: "p" },
      deps: {
        mint: async () => mintedFixture(),
        sendSmtp: async () => {
          throw new AmtClientError("smtp_error: 550 bounce");
        },
        sendGmail: async () => {
          throw new Error("gmail must not run");
        },
        nowIso: () => "2026-09-21T12:00:00.000Z",
      },
    });

    expect(result.summary).toEqual({ total: 1, minted: 0, sent: 0, error: 1 });
    expect(result.records[0]?.status).toBe("error");
    expect(result.records[0]?.message_id).toBe("msg_ada");
    expect(result.records[0]?.pixel_url).toBe("https://track.example/o/tok");
    expect(result.records[0]?.error).toMatch(/550 bounce/);
    expect(result.records[0]?.via).toBe("smtp");
    expect(result.records[0]?.sent_at).toBe("");
  });

  it("marks sent after a successful SMTP send", async () => {
    const sendSmtp = vi.fn(async () => ({ accepted: true as const, code: 250, response: "ok" }));
    const result = await runBatch({
      records: [{ to: "ada@example.com", subject: "Hi", text: "Hello" }],
      headers: ["to", "subject", "text"],
      mintOnly: false,
      via: "smtp",
      delayMs: 0,
      defaultFrom: "you@icloud.com",
      baseUrl: "https://track.example",
      apiKey: "k",
      smtp: { host: "smtp.example", port: 587, user: "u", pass: "p" },
      deps: {
        mint: async () => mintedFixture(),
        sendSmtp,
        sendGmail: async () => {
          throw new Error("gmail must not run");
        },
        nowIso: () => "2026-09-21T12:00:00.000Z",
      },
    });

    expect(sendSmtp).toHaveBeenCalledOnce();
    expect(result.records[0]?.status).toBe("sent");
    expect(result.records[0]?.sent_at).toBe("2026-09-21T12:00:00.000Z");
    expect(result.records[0]?.via).toBe("smtp");
    expect(result.summary.sent).toBe(1);
  });

  it("records optional raw_path when writeRaw is provided (mint-only)", async () => {
    const writeRaw = vi.fn(async (messageId: string) => `/tmp/wave-raw/${messageId}.eml`);
    const result = await runBatch({
      records: [{ to: "ada@example.com", subject: "Hi", text: "Hello" }],
      headers: ["to", "subject", "text"],
      mintOnly: true,
      delayMs: 0,
      baseUrl: "https://track.example",
      apiKey: "k",
      deps: {
        mint: async () => mintedFixture({ message_id: "msg_raw" }),
        writeRaw,
        sendSmtp: async () => {
          throw new Error("smtp must not run");
        },
        sendGmail: async () => {
          throw new Error("gmail must not run");
        },
      },
    });
    expect(writeRaw).toHaveBeenCalledWith("msg_raw", expect.stringContaining("MIME-Version"));
    expect(result.headers).toContain("raw_path");
    expect(result.records[0]?.raw_path).toBe("/tmp/wave-raw/msg_raw.eml");
    expect(result.records[0]?.status).toBe("minted");
  });
});

describe("batch CLI usage", () => {
  it("documents mint-only, via, delay, and result columns", () => {
    expect(BATCH_USAGE).toMatch(/--mint-only/);
    expect(BATCH_USAGE).toMatch(/--via smtp\|gmail_raw/);
    expect(BATCH_USAGE).toMatch(/--delay-ms/);
    expect(BATCH_USAGE).toMatch(/message_id/);
    expect(BATCH_USAGE).not.toMatch(/htmlBody is required/);
  });
});
