import { describe, expect, it } from "vitest";
import { assertSendableRawMime } from "../client/guard";
import {
  MINT_WINDOW_MS,
  MINT_WRITES_PER_KEY_PER_HOUR,
  mintRetryAfterSeconds,
  mintWindowUsage,
  mintWriteAllowed,
} from "../src/db";
import app from "../src/index";

interface StoredMessage {
  id: string;
  created_at: string;
  recipient: string;
}

interface StoredLink {
  id: string;
  message_id: string;
  original_url: string;
  created_at: string;
}

function createMintDb(seed: { created_at: string }[] = []) {
  const messages: StoredMessage[] = seed.map((row, i) => ({
    id: `seed_${i}`,
    created_at: row.created_at,
    recipient: "ada@example.com",
  }));
  const links: StoredLink[] = [];

  function execute(text: string, args: unknown[]): { success: true } {
    if (text.startsWith("INSERT INTO messages")) {
      messages.push({
        id: String(args[0]),
        created_at: String(args[1]),
        recipient: String(args[2]),
      });
      return { success: true };
    }
    if (text.startsWith("INSERT INTO links")) {
      links.push({
        id: String(args[0]),
        message_id: String(args[1]),
        original_url: String(args[2]),
        created_at: String(args[3]),
      });
      return { success: true };
    }
    throw new Error(`unexpected run: ${text}`);
  }

  const db = {
    prepare(sql: string) {
      const text = sql.replace(/\s+/g, " ").trim();
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              if (text.startsWith("SELECT COUNT(*)")) {
                const windowStart = String(args[0]);
                const inWindow = messages.filter((row) => row.created_at >= windowStart);
                const oldest = inWindow.reduce<string | null>(
                  (min, row) => (min == null || row.created_at < min ? row.created_at : min),
                  null,
                );
                return { in_window: inWindow.length, oldest } as T;
              }
              throw new Error(`unexpected first: ${text}`);
            },
            async run() {
              return execute(text, args);
            },
          };
        },
      };
    },
    async batch(statements: { run: () => Promise<{ success: true }> }[]) {
      for (const statement of statements) await statement.run();
    },
  };

  return { db: db as unknown as D1Database, messages, links };
}

function mintEnv(db: D1Database) {
  return { DB: db, API_KEY: "test-key", TOKEN_SECRET: "secret" };
}

const mintBody = {
  to: "ada@example.com",
  from: "you@example.com",
  subject: "Hello",
  text: "Hi Ada — see https://example.com/docs",
};

describe("mintWriteAllowed", () => {
  it("allows counts under the cap and rejects the cap itself", () => {
    expect(mintWriteAllowed(0)).toBe(true);
    expect(mintWriteAllowed(MINT_WRITES_PER_KEY_PER_HOUR - 1)).toBe(true);
    expect(mintWriteAllowed(MINT_WRITES_PER_KEY_PER_HOUR)).toBe(false);
    expect(mintWriteAllowed(Number.NaN)).toBe(false);
  });

  it("counts only messages inside the rolling hour", async () => {
    const now = "2026-09-23T12:00:00.000Z";
    const edge = new Date(Date.parse(now) - MINT_WINDOW_MS).toISOString();
    const before = new Date(Date.parse(now) - MINT_WINDOW_MS - 1).toISOString();
    const { db } = createMintDb([{ created_at: edge }, { created_at: before }, { created_at: now }]);
    const usage = await mintWindowUsage(db, now);
    expect(edge).toBe("2026-09-23T11:00:00.000Z");
    expect(usage.inWindow).toBe(2);
    expect(usage.oldest).toBe(edge);
  });

  it("fails closed when the clock or the count is unusable", async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return { in_window: "nope", oldest: null };
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    const badCount = await mintWindowUsage(db, "2026-09-23T12:00:00.000Z");
    expect(mintWriteAllowed(badCount.inWindow)).toBe(false);
    const badClock = await mintWindowUsage(db, "not-a-date");
    expect(mintWriteAllowed(badClock.inWindow)).toBe(false);
  });
});

describe("mintRetryAfterSeconds", () => {
  it("waits until the oldest mint leaves the hour", () => {
    const now = "2026-09-23T12:00:00.000Z";
    expect(mintRetryAfterSeconds(now, now)).toBe(3600);
    expect(mintRetryAfterSeconds(now, "2026-09-23T11:01:00.000Z")).toBe(60);
    expect(mintRetryAfterSeconds(now, null)).toBe(3600);
    expect(mintRetryAfterSeconds(now, "2026-09-23T10:00:00.000Z")).toBe(1);
  });
});

describe("POST /v1/messages mint cap", () => {
  it("keeps the 201 body and stores the message and its link under the cap", async () => {
    const { db, messages, links } = createMintDb();
    const res = await app.request(
      "http://track.example/v1/messages",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(mintBody),
      },
      mintEnv(db),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      message_id: string;
      mode: string;
      open_tracking: boolean;
      opens: number;
      status: string;
      raw_mime: string;
      raw_base64url: string;
      links: { original_url: string }[];
    };
    expect(body.mode).toBe("plain_looking");
    expect(body.open_tracking).toBe(true);
    expect(body.opens).toBe(0);
    expect(body.status).toBe("no_signal");
    expect(body.message_id.startsWith("msg_")).toBe(true);
    assertSendableRawMime(body);
    expect(body.links.map((link) => link.original_url)).toEqual(["https://example.com/docs"]);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe(body.message_id);
    expect(links).toHaveLength(1);
    expect(links[0]?.message_id).toBe(body.message_id);
  });

  it("mints the last row under the cap and rejects the next one with no write", async () => {
    const recent = new Date().toISOString();
    const { db, messages, links } = createMintDb(
      Array.from({ length: MINT_WRITES_PER_KEY_PER_HOUR - 1 }, () => ({ created_at: recent })),
    );
    const allowed = await app.request(
      "http://track.example/v1/messages",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(mintBody),
      },
      mintEnv(db),
    );
    expect(allowed.status).toBe(201);
    expect(messages).toHaveLength(MINT_WRITES_PER_KEY_PER_HOUR);

    const blocked = await app.request(
      "http://track.example/v1/messages",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(mintBody),
      },
      mintEnv(db),
    );
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: "rate_limited" });
    const retryAfter = Number(blocked.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(3600);
    expect(messages).toHaveLength(MINT_WRITES_PER_KEY_PER_HOUR);
    expect(links).toHaveLength(1);
  });

  it("ignores mints older than the rolling hour", async () => {
    const stale = new Date(Date.now() - 2 * MINT_WINDOW_MS).toISOString();
    const { db, messages } = createMintDb(
      Array.from({ length: MINT_WRITES_PER_KEY_PER_HOUR }, () => ({ created_at: stale })),
    );
    const res = await app.request(
      "http://track.example/v1/messages",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ to: "ada@example.com", text: "Hi" }),
      },
      mintEnv(db),
    );
    expect(res.status).toBe(201);
    expect(messages).toHaveLength(MINT_WRITES_PER_KEY_PER_HOUR + 1);
  });

  it("rejects a bad body and a missing key before reading D1", async () => {
    const db = {
      prepare() {
        throw new Error("db should not be used");
      },
    } as unknown as D1Database;
    const invalid = await app.request(
      "http://track.example/v1/messages",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: "Hi" }),
      },
      mintEnv(db),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid_to" });

    const anonymous = await app.request(
      "http://track.example/v1/messages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mintBody),
      },
      mintEnv(db),
    );
    expect(anonymous.status).toBe(401);
  });
});
