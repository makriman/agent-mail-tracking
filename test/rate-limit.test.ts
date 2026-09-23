import { describe, expect, it } from "vitest";
import {
  EVENT_WRITES_PER_IP_TOKEN_PER_HOUR,
  eventWriteAllowed,
  recordEvent,
  type RecordEventInput,
} from "../src/db";
import app from "../src/index";
import { hashIp, signToken } from "../src/tokens";
import type { MessageRow } from "../src/types";

interface StoredEvent {
  id: string;
  message_id: string;
  link_id: string | null;
  type: string;
  created_at: string;
  ip_hash: string | null;
  user_agent: string | null;
  classification: string;
  cf_country: string | null;
  deduped: number;
}

function messageRow(over: Partial<MessageRow> = {}): MessageRow {
  return {
    id: "msg_1",
    created_at: "2026-09-23T00:00:00.000Z",
    recipient: "ada@example.com",
    subject: "Hi",
    mode: "plain_looking",
    open_tracking: 1,
    metadata: null,
    webhook_url: "https://hooks.example/mail",
    base_url: "https://track.example",
    first_open_at: null,
    first_click_at: null,
    open_count: 0,
    click_count: 0,
    last_classification: null,
    last_event_at: null,
    ...over,
  };
}

function createFakeDb(message: MessageRow, events: StoredEvent[] = []) {
  const messages = new Map<string, MessageRow>([[message.id, message]]);
  const db = {
    prepare(sql: string) {
      const text = sql.replace(/\s+/g, " ").trim();
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              if (text.startsWith("SELECT * FROM messages")) {
                return (messages.get(String(args[0])) ?? null) as T | null;
              }
              if (text.startsWith("SELECT COUNT(*)")) {
                const messageId = String(args[0]);
                const type = String(args[1]);
                const ip = String(args[2]);
                const linkId = String(args[3]);
                const windowStart = String(args[4]);
                const inWindow = events.filter(
                  (event) =>
                    event.message_id === messageId &&
                    event.type === type &&
                    (event.ip_hash ?? "") === ip &&
                    (event.link_id ?? "") === linkId &&
                    event.created_at >= windowStart,
                ).length;
                return { in_window: inWindow } as T;
              }
              if (text.startsWith("SELECT id FROM events")) {
                const messageId = String(args[0]);
                const type = String(args[1]);
                const ip = String(args[2]);
                const ua = String(args[3]);
                const windowStart = String(args[4]);
                const hit = events.find(
                  (event) =>
                    event.message_id === messageId &&
                    event.type === type &&
                    (event.ip_hash ?? "") === ip &&
                    (event.user_agent ?? "") === ua &&
                    event.created_at >= windowStart,
                );
                return (hit ? { id: hit.id } : null) as T | null;
              }
              throw new Error(`unexpected first: ${text}`);
            },
            async run(): Promise<{ success: true }> {
              if (text.startsWith("INSERT INTO events")) {
                events.push({
                  id: String(args[0]),
                  message_id: String(args[1]),
                  link_id: args[2] == null ? null : String(args[2]),
                  type: String(args[3]),
                  created_at: String(args[4]),
                  ip_hash: args[5] == null ? null : String(args[5]),
                  user_agent: args[6] == null ? null : String(args[6]),
                  classification: String(args[7]),
                  cf_country: args[8] == null ? null : String(args[8]),
                  deduped: Number(args[9]),
                });
                return { success: true };
              }
              if (text.startsWith("UPDATE messages")) {
                const row = messages.get(String(args[3]));
                if (!row) throw new Error("missing message");
                if (text.includes("open_count")) {
                  row.open_count += 1;
                  row.first_open_at = row.first_open_at ?? String(args[0]);
                } else {
                  row.click_count += 1;
                  row.first_click_at = row.first_click_at ?? String(args[0]);
                }
                row.last_classification = String(args[1]);
                row.last_event_at = String(args[2]);
                return { success: true };
              }
              throw new Error(`unexpected run: ${text}`);
            },
          };
        },
      };
    },
  };
  return { db: db as unknown as D1Database, events, messages };
}

function openInput(over: Partial<RecordEventInput> = {}): RecordEventInput {
  return {
    id: "evt_1",
    message_id: "msg_1",
    link_id: null,
    type: "open",
    created_at: "2026-09-23T12:00:00.000Z",
    ip_hash: "ip",
    user_agent: "Mozilla/5.0",
    classification: "human_likely",
    cf_country: "US",
    ...over,
  };
}

describe("eventWriteAllowed", () => {
  it("allows the first hits from an IP and rejects the next one", () => {
    expect(eventWriteAllowed(0)).toBe(true);
    expect(eventWriteAllowed(EVENT_WRITES_PER_IP_TOKEN_PER_HOUR - 1)).toBe(true);
    expect(eventWriteAllowed(EVENT_WRITES_PER_IP_TOKEN_PER_HOUR)).toBe(false);
    expect(eventWriteAllowed(Number.NaN)).toBe(false);
  });
});

describe("recordEvent rate limit", () => {
  it("still stores a deduped timeline row while under the cap", async () => {
    const { db, events, messages } = createFakeDb(messageRow());
    const first = await recordEvent(db, openInput({ id: "evt_1" }));
    const second = await recordEvent(db, openInput({ id: "evt_2" }));
    expect(first).toMatchObject({ first: true, deduped: false, rateLimited: false });
    expect(second).toMatchObject({ first: false, deduped: true, rateLimited: false });
    expect(events.map((event) => event.deduped)).toEqual([0, 1]);
    expect(messages.get("msg_1")?.open_count).toBe(1);
    expect(messages.get("msg_1")?.first_open_at).toBe("2026-09-23T12:00:00.000Z");
  });

  it("stops one IP from filling D1 and still records a different IP", async () => {
    const { db, events, messages } = createFakeDb(messageRow());
    for (let i = 0; i < EVENT_WRITES_PER_IP_TOKEN_PER_HOUR; i++) {
      const result = await recordEvent(db, openInput({ id: `evt_${i}`, user_agent: `ua-${i}`, ip_hash: "ip-spam" }));
      expect(result?.rateLimited).toBe(false);
    }
    const blocked = await recordEvent(db, openInput({ id: "evt_over", user_agent: "ua-over", ip_hash: "ip-spam" }));
    expect(blocked).toMatchObject({ first: false, rateLimited: true });
    expect(events).toHaveLength(EVENT_WRITES_PER_IP_TOKEN_PER_HOUR);

    const human = await recordEvent(db, openInput({ id: "evt_human", user_agent: "Mozilla/5.0 Chrome", ip_hash: "ip-human" }));
    expect(human).toMatchObject({ deduped: false, rateLimited: false });
    expect(events).toHaveLength(EVENT_WRITES_PER_IP_TOKEN_PER_HOUR + 1);
    expect(messages.get("msg_1")?.open_count).toBe(EVENT_WRITES_PER_IP_TOKEN_PER_HOUR + 1);
  });

  it("still writes the first open when that IP bucket is already full", async () => {
    const seeded = Array.from({ length: EVENT_WRITES_PER_IP_TOKEN_PER_HOUR }, (_, i) => ({
      id: `old_${i}`,
      message_id: "msg_1",
      link_id: null,
      type: "open",
      created_at: "2026-09-23T12:00:00.000Z",
      ip_hash: "ip-spam",
      user_agent: `ua-${i}`,
      classification: "unknown",
      cf_country: null,
      deduped: 0,
    }));
    const { db, events, messages } = createFakeDb(messageRow({ first_open_at: null, open_count: 0 }), seeded);
    const result = await recordEvent(db, openInput({ id: "evt_first", ip_hash: "ip-spam" }));
    expect(result).toMatchObject({ first: true, rateLimited: false });
    expect(events).toHaveLength(EVENT_WRITES_PER_IP_TOKEN_PER_HOUR + 1);
    expect(messages.get("msg_1")?.first_open_at).toBe("2026-09-23T12:00:00.000Z");
  });

  it("caps clicks per link token and still records another link from the same IP", async () => {
    const { db, events } = createFakeDb(messageRow({ first_click_at: "2026-09-23T11:00:00.000Z" }));
    for (let i = 0; i < EVENT_WRITES_PER_IP_TOKEN_PER_HOUR; i++) {
      await recordEvent(db, openInput({ id: `clk_${i}`, type: "click", link_id: "lnk_a", user_agent: `ua-${i}` }));
    }
    const blocked = await recordEvent(
      db,
      openInput({ id: "clk_over", type: "click", link_id: "lnk_a", user_agent: "ua-over" }),
    );
    const other = await recordEvent(db, openInput({ id: "clk_b", type: "click", link_id: "lnk_b", user_agent: "ua-b" }));
    expect(blocked?.rateLimited).toBe(true);
    expect(other?.rateLimited).toBe(false);
    expect(events.filter((event) => event.link_id === "lnk_a")).toHaveLength(EVENT_WRITES_PER_IP_TOKEN_PER_HOUR);
    expect(events.filter((event) => event.link_id === "lnk_b")).toHaveLength(1);
  });

  it("does not write opens when open tracking is off", async () => {
    const { db, events } = createFakeDb(messageRow({ open_tracking: 0 }));
    const result = await recordEvent(db, openInput());
    expect(result).toMatchObject({ deduped: true, rateLimited: false });
    expect(events).toHaveLength(0);
  });
});

describe("GET /o under the write cap", () => {
  it("still returns the GIF and does not insert or call the webhook", async () => {
    const ipHash = await hashIp("203.0.113.5", "secret");
    const seenAt = new Date().toISOString();
    const seeded = Array.from({ length: EVENT_WRITES_PER_IP_TOKEN_PER_HOUR }, (_, i) => ({
      id: `life_${i}`,
      message_id: "msg_1",
      link_id: null,
      type: "open",
      created_at: seenAt,
      ip_hash: ipHash,
      user_agent: `ua-${i}`,
      classification: "unknown",
      cf_country: null,
      deduped: 0,
    }));
    const { db, events } = createFakeDb(
      messageRow({ first_open_at: seenAt, open_count: EVENT_WRITES_PER_IP_TOKEN_PER_HOUR }),
      seeded,
    );
    const token = await signToken("o", "msg_1", "secret");
    let waited = false;
    const res = await app.request(
      `http://track.example/o/${token}`,
      { headers: { "CF-Connecting-IP": "203.0.113.5", "User-Agent": "Mozilla/5.0" } },
      { DB: db, API_KEY: "k", TOKEN_SECRET: "secret" },
      {
        waitUntil(promise: Promise<unknown>) {
          waited = true;
          return promise;
        },
        passThroughOnException() {},
        props: {},
      },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/gif");
    expect(events).toHaveLength(EVENT_WRITES_PER_IP_TOKEN_PER_HOUR);
    expect(waited).toBe(false);
  });
});
