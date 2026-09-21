import { afterEach, describe, expect, it, vi } from "vitest";
import { HTML_BODY_BANNED } from "../client/guard";
import {
  BATCH_USAGE,
  DEFAULT_CAMPAIGN,
  LOG_COLUMNS,
  MAILMERGE_COLUMNS,
  csvEscape,
  mergeHeaders,
  parseCampaign,
  parseCsv,
  parseCsvRecords,
  parseDelayMs,
  parseTouch,
  resolveBodyText,
  resolveRecipient,
  runBatch,
  stringifyCsv,
  stringifyCsvRecords,
} from "../client/batch";
import { AmtClientError, type MintedMessage } from "../client/types";

/** Mirrors test/fixtures/mailmerge-e1.csv (do not depend on /workspace/eslams-outbound-500). */
const MAILMERGE_E1 = [
  "send_batch_order,contact_id,first_name,email,subject,body_text",
  '1,c_ada,Ada,ada@lab.edu,Quick question on your preprint,"Hi Ada — I read your paper on low-stakes assessment. Would you have 20 minutes to compare notes?"',
  '2,c_bob,Bob,bob@lab.edu,Following up,"Hi Bob — circling back on the methods note. No rush if now is a busy stretch."',
].join("\n");

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
    to: "ada@lab.edu",
    from: "makriman@berkeley.edu",
    subject: "Hello",
    text: "Hi",
    html: '<p>Hi</p>\n<img src="https://track.example/o/tok" width="1" height="1" alt="">',
    raw_mime: 'MIME-Version: 1.0\r\nFrom: makriman@berkeley.edu\r\n<img src="https://track.example/o/tok">',
    raw_base64url: "TUlNRS1WZXJzaW9uOiAxLjA",
    pixel_url: "https://track.example/o/tok",
    base_url: "https://track.greatindiancompany.com",
    links: [],
    created_at: "2026-09-21T00:00:00.000Z",
    ...over,
  };
}

describe("CSV parse", () => {
  it("parses mailmerge headers, quoted commas, and newlines", () => {
    const { headers, records } = parseCsvRecords(MAILMERGE_E1);
    expect(headers).toEqual([...MAILMERGE_COLUMNS]);
    expect(records).toHaveLength(2);
    expect(resolveRecipient(records[0]!)).toBe("ada@lab.edu");
    expect(resolveBodyText(records[0]!)).toContain("low-stakes assessment");
    expect(resolveBodyText(records[0]!)).not.toMatch(/https?:\/\//);
    expect(records[1]?.first_name).toBe("Bob");
  });

  it("strips BOM, skips blank lines, and keeps extra columns", () => {
    const text = "\uFEFFemail,subject,body_text,wave\n\nada@lab.edu,Hello,Hi,gtm-1\n\n";
    const { headers, records } = parseCsvRecords(text);
    expect(headers).toEqual(["email", "subject", "body_text", "wave"]);
    expect(records).toEqual([{ email: "ada@lab.edu", subject: "Hello", body_text: "Hi", wave: "gtm-1" }]);
  });

  it("round-trips via stringifyCsv", () => {
    const rows = [
      ["email", "body_text"],
      ["ada@lab.edu", 'Hi, "Ada"'],
    ];
    const csv = stringifyCsv(rows);
    expect(csvEscape('Hi, "Ada"')).toBe('"Hi, ""Ada"""');
    expect(parseCsv(csv)).toEqual(rows);
  });

  it("stringifyCsvRecords appends handoff log columns without dropping mailmerge cols", () => {
    const headers = mergeHeaders([...MAILMERGE_COLUMNS], LOG_COLUMNS);
    const csv = stringifyCsvRecords(headers, [
      {
        send_batch_order: "1",
        contact_id: "c_ada",
        first_name: "Ada",
        email: "ada@lab.edu",
        subject: "Hello",
        body_text: "Hi Ada",
        campaign: DEFAULT_CAMPAIGN,
        touch: "E1",
        amt_message_id: "msg_1",
        sent_at: "",
        open_status: "",
        open_at: "",
        bounce_or_error: "",
      },
    ]);
    const parsed = parseCsvRecords(csv);
    expect(parsed.headers).toEqual([...MAILMERGE_COLUMNS, ...LOG_COLUMNS]);
    expect(parsed.records[0]?.amt_message_id).toBe("msg_1");
    expect(parsed.records[0]?.contact_id).toBe("c_ada");
    expect(parsed.records[0]?.campaign).toBe(DEFAULT_CAMPAIGN);
  });

  it("rejects unterminated quotes and duplicate headers", () => {
    expect(() => parseCsv('"nope')).toThrow(AmtClientError);
    expect(() => parseCsvRecords("email,email\nada@lab.edu,x")).toThrow(/duplicate header/);
  });
});

describe("flags", () => {
  it("parseDelayMs defaults to 1000 and accepts 0", () => {
    expect(parseDelayMs(undefined)).toBe(1000);
    expect(parseDelayMs("0")).toBe(0);
    expect(() => parseDelayMs("-1")).toThrow(/delay-ms/);
  });

  it("parseTouch accepts E1|E2|E3 and rejects others", () => {
    expect(parseTouch("e1")).toBe("E1");
    expect(parseTouch("E2")).toBe("E2");
    expect(parseTouch("E3")).toBe("E3");
    expect(() => parseTouch(undefined)).toThrow(/--touch/);
    expect(() => parseTouch("E4")).toThrow(/--touch/);
  });

  it("parseCampaign defaults to the eSlams 2026-09 slug", () => {
    expect(parseCampaign(undefined)).toBe("eslams-researcher-lowstakes-2026-09");
    expect(parseCampaign("")).toBe(DEFAULT_CAMPAIGN);
    expect(parseCampaign("custom")).toBe("custom");
  });
});

describe("mint-only dry run (mocked fetch) — eSlams mailmerge", () => {
  it("maps email→to and body_text→text, writes amt_message_id, and never sends", async () => {
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

    const input = parseCsvRecords(MAILMERGE_E1);
    const result = await runBatch({
      records: input.records,
      headers: input.headers,
      mintOnly: true,
      delayMs: 1000,
      defaultFrom: "makriman@berkeley.edu",
      campaign: DEFAULT_CAMPAIGN,
      touch: "E1",
      baseUrl: "https://track.greatindiancompany.com/",
      apiKey: "k-test",
      via: "smtp",
      smtp: { host: "smtp.example", port: 587, user: "u", pass: "p" },
      deps: { sendSmtp, sendGmail, sleep: sleepMock, nowIso: () => "2026-09-21T12:00:00.000Z" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sendSmtp).not.toHaveBeenCalled();
    expect(sendGmail).not.toHaveBeenCalled();
    expect(sleepMock).toHaveBeenCalledWith(1000);

    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(firstBody.to).toBe("ada@lab.edu");
    expect(firstBody.from).toBe("makriman@berkeley.edu");
    expect(firstBody.subject).toBe("Quick question on your preprint");
    expect(firstBody.text).toBe(
      "Hi Ada — I read your paper on low-stakes assessment. Would you have 20 minutes to compare notes?",
    );
    expect(firstBody.text).not.toMatch(/https?:\/\//);
    expect(firstBody.mode).toBe("plain_looking");
    expect(firstBody.metadata).toEqual({
      campaign: DEFAULT_CAMPAIGN,
      touch: "E1",
      contact_id: "c_ada",
      send_batch_order: "1",
    });
    expect(firstBody).not.toHaveProperty("htmlBody");
    expect(firstBody).not.toHaveProperty("html");

    expect(result.summary).toEqual({ total: 2, minted: 2, sent: 0, error: 0 });
    expect(result.headers).toEqual(expect.arrayContaining([...MAILMERGE_COLUMNS, ...LOG_COLUMNS]));
    expect(result.records[0]?.contact_id).toBe("c_ada");
    expect(result.records[0]?.email).toBe("ada@lab.edu");
    expect(result.records[0]?.send_batch_order).toBe("1");
    expect(result.records[0]?.campaign).toBe(DEFAULT_CAMPAIGN);
    expect(result.records[0]?.touch).toBe("E1");
    expect(result.records[0]?.amt_message_id).toBe("msg_ada");
    expect(result.records[0]?.sent_at).toBe("");
    expect(result.records[0]?.open_status).toBe("");
    expect(result.records[0]?.open_at).toBe("");
    expect(result.records[0]?.bounce_or_error).toBe("");
    expect(result.records[1]?.amt_message_id).toBe("msg_bob");
    expect(result.csv).toContain("amt_message_id");
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
        "send_batch_order,contact_id,first_name,email,subject,body_text",
        "1,c_bad,Bad,not-an-email,Skip me,Hi",
        "2,c_ada,Ada,ada@lab.edu,Hello,Hi Ada",
        "3,c_empty,Empty,empty@lab.edu,Hello,",
      ].join("\n"),
    );

    const result = await runBatch({
      records: input.records,
      headers: input.headers,
      mintOnly: true,
      delayMs: 0,
      defaultFrom: "makriman@berkeley.edu",
      touch: "E1",
      baseUrl: "https://track.greatindiancompany.com",
      apiKey: "k",
    });

    expect(result.summary).toEqual({ total: 3, minted: 1, sent: 0, error: 2 });
    expect(result.records[0]?.bounce_or_error).toMatch(/email\/to must be an email/);
    expect(result.records[0]?.amt_message_id).toBe("");
    expect(result.records[1]?.amt_message_id).toBe("msg_ok");
    expect(result.records[1]?.bounce_or_error).toBe("");
    expect(result.records[2]?.bounce_or_error).toMatch(/missing body_text\/text/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not mint rows that carry htmlBody", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const input = parseCsvRecords(
      "send_batch_order,contact_id,email,subject,body_text,htmlBody\n1,c_ada,ada@lab.edu,Hello,Hi,<p>nope</p>\n",
    );
    const result = await runBatch({
      records: input.records,
      headers: input.headers,
      mintOnly: true,
      delayMs: 0,
      defaultFrom: "makriman@berkeley.edu",
      touch: "E1",
      baseUrl: "https://track.example",
      apiKey: "k",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.records[0]?.bounce_or_error).toBe(HTML_BODY_BANNED);
    expect(result.records[0]?.amt_message_id).toBe("");
  });

  it("keeps amt_message_id when mint works and send fails", async () => {
    const result = await runBatch({
      records: [{ email: "ada@lab.edu", subject: "Hi", body_text: "Hello" }],
      headers: ["email", "subject", "body_text"],
      mintOnly: false,
      via: "smtp",
      delayMs: 0,
      defaultFrom: "makriman@berkeley.edu",
      touch: "E2",
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
    expect(result.records[0]?.amt_message_id).toBe("msg_ada");
    expect(result.records[0]?.bounce_or_error).toMatch(/550 bounce/);
    expect(result.records[0]?.sent_at).toBe("");
    expect(result.records[0]?.touch).toBe("E2");
  });

  it("marks sent_at after a successful SMTP send", async () => {
    const sendSmtp = vi.fn(async () => ({ accepted: true as const, code: 250, response: "ok" }));
    const result = await runBatch({
      records: [{ email: "ada@lab.edu", subject: "Hi", body_text: "Hello" }],
      headers: ["email", "subject", "body_text"],
      mintOnly: false,
      via: "smtp",
      delayMs: 0,
      defaultFrom: "makriman@berkeley.edu",
      touch: "E3",
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
    expect(result.records[0]?.sent_at).toBe("2026-09-21T12:00:00.000Z");
    expect(result.records[0]?.bounce_or_error).toBe("");
    expect(result.records[0]?.amt_message_id).toBe("msg_ada");
    expect(result.summary.sent).toBe(1);
  });

  it("records optional raw_path when writeRaw is provided (mint-only)", async () => {
    const writeRaw = vi.fn(async (messageId: string) => `/tmp/wave-raw/${messageId}.eml`);
    const result = await runBatch({
      records: [{ email: "ada@lab.edu", subject: "Hi", body_text: "Hello" }],
      headers: ["email", "subject", "body_text"],
      mintOnly: true,
      delayMs: 0,
      defaultFrom: "makriman@berkeley.edu",
      touch: "E1",
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
    expect(result.records[0]?.amt_message_id).toBe("msg_raw");
  });
});

describe("batch CLI usage", () => {
  it("documents eSlams prepare flags and mailmerge columns", () => {
    expect(BATCH_USAGE).toMatch(/--mint-only/);
    expect(BATCH_USAGE).toMatch(/--touch E1\|E2\|E3/);
    expect(BATCH_USAGE).toMatch(/eslams-researcher-lowstakes-2026-09/);
    expect(BATCH_USAGE).toMatch(/makriman@berkeley\.edu/);
    expect(BATCH_USAGE).toMatch(/body_text/);
    expect(BATCH_USAGE).toMatch(/amt_message_id/);
    expect(BATCH_USAGE).toMatch(/MAILMERGE-E1/);
    expect(BATCH_USAGE).not.toMatch(/htmlBody is required/);
  });
});
