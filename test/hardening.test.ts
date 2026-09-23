import { describe, expect, it } from "vitest";
import { renderList } from "../src/dashboard";
import { listHumanOpenIds } from "../src/db";
import app from "../src/index";
import { signToken, verifyToken } from "../src/tokens";
import type { MessageRow } from "../src/types";

function message(over: Partial<MessageRow> = {}): MessageRow {
  return {
    id: "msg_1",
    created_at: "2026-09-23T00:00:00.000Z",
    recipient: "ada@example.com",
    subject: "Hi",
    mode: "plain_looking",
    open_tracking: 1,
    metadata: null,
    webhook_url: null,
    base_url: "https://track.example",
    first_open_at: "2026-09-23T01:00:00.000Z",
    first_click_at: null,
    open_count: 2,
    click_count: 0,
    last_classification: "gmail_proxy",
    last_event_at: "2026-09-23T02:00:00.000Z",
    ...over,
  };
}

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

describe("dashboard list status", () => {
  it("uses a prior human open even when the latest classification is a proxy", () => {
    const row = message();
    expect(renderList([row])).toContain("Proxy / suspected open");
    const withHuman = renderList([row], new Set([row.id]));
    expect(withHuman).toContain("High-confidence open");
    expect(withHuman).not.toContain("Proxy / suspected open");
  });

  it("loads human-open ids with one parameterized query", async () => {
    let seen = "";
    const db = {
      prepare(sql: string) {
        seen = sql.replace(/\s+/g, " ").trim();
        return {
          bind(...args: unknown[]) {
            expect(args).toEqual(["msg_a", "msg_b"]);
            return {
              async all() {
                return { results: [{ message_id: "msg_a" }] };
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    await expect(listHumanOpenIds(db, [])).resolves.toEqual(new Set());
    await expect(listHumanOpenIds(db, ["msg_a", "msg_b"])).resolves.toEqual(new Set(["msg_a"]));
    expect(seen).toContain("classification = 'human_likely'");
    expect(seen).toContain("IN (?, ?)");
  });
});

describe("POST /v1/messages body cap", () => {
  it("rejects a body over 512 KiB before minting", async () => {
    const res = await app.request(
      "http://track.example/v1/messages",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
        },
        body: "x".repeat(512 * 1024 + 1),
      },
      { API_KEY: "test-key", TOKEN_SECRET: "secret", DB: {} as D1Database },
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "body_too_large" });
  });
});
