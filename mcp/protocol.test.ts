import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HTML_BODY_BANNED } from "../client/guard";
import type { MintedMessage } from "../client/types";
import { OPEN_TRACKING_INSTRUCTION } from "./copy";
import type { AmtToolDeps } from "./handlers";
import { createAmtMcpServer } from "./server";

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
  html: null,
  raw_mime: '<img src="https://track.example/o/tok">',
  raw_base64url: "YQ",
  pixel_url: "https://track.example/o/tok",
  base_url: "https://track.example",
  links: [],
  created_at: "2026-09-22T00:00:00.000Z",
};

const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function connect(partial: Partial<AmtToolDeps> = {}) {
  const unexpected = async () => {
    throw new Error("unexpected outbound call");
  };
  const deps: AmtToolDeps = {
    mintTrackedMessage: vi.fn(async () => minted) as AmtToolDeps["mintTrackedMessage"],
    sendTrackedEmail: unexpected as AmtToolDeps["sendTrackedEmail"],
    getTrackedMessage: unexpected as AmtToolDeps["getTrackedMessage"],
    sendRawMimeSmtp: unexpected as AmtToolDeps["sendRawMimeSmtp"],
    sendRawGmail: unexpected as AmtToolDeps["sendRawGmail"],
    runBatch: unexpected as AmtToolDeps["runBatch"],
    sleep: async () => {},
    ...partial,
  };
  const server = createAmtMcpServer(
    {
      baseUrl: "https://track.example",
      apiKey: "k-test",
      smtp: { host: "smtp.example", port: 587, user: "you@icloud.com", pass: "secret-pass", secure: false },
    },
    deps,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "amt-test", version: "0.0.0" });
  clients.push(client);
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, deps };
}

function toolText(result: { isError?: boolean; content?: unknown }): string {
  const content = result.content;
  if (!Array.isArray(content)) throw new Error("expected content");
  const block = content[0] as { type?: string; text?: string } | undefined;
  if (!block || block.type !== "text" || block.text == null) throw new Error("expected text content");
  return block.text;
}

describe("MCP tool surface", () => {
  it("advertises the four tools without htmlBody parameters", async () => {
    const { client } = await connect();
    expect(client.getInstructions()).toContain(OPEN_TRACKING_INSTRUCTION);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "mint_tracked_message",
      "send_tracked_email",
      "get_tracked_message",
      "mint_tracked_batch",
    ]);
    for (const tool of listed.tools) {
      expect(tool.description).toContain("htmlBody");
      expect(tool.description).toContain("textBody");
      expect(tool.description).toContain(OPEN_TRACKING_INSTRUCTION);
      const schema = tool.inputSchema as { properties?: Record<string, unknown> };
      expect(schema.properties).not.toHaveProperty("htmlBody");
      expect(schema.properties).not.toHaveProperty("textBody");
      expect(schema.properties).not.toHaveProperty("html_body");
      expect(schema.properties).not.toHaveProperty("text_body");
      expect(Object.keys(schema.properties ?? {}).length).toBeGreaterThan(0);
    }
    const send = listed.tools.find((tool) => tool.name === "send_tracked_email");
    const sendProps = (send?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(sendProps).not.toHaveProperty("smtp_pass");
    expect(sendProps).not.toHaveProperty("access_token");
    expect(sendProps).toHaveProperty("via");
    expect(sendProps).toHaveProperty("from");
  });

  it("mints through the protocol and rejects htmlBody", async () => {
    const { client, deps } = await connect();
    const result = await client.callTool({
      name: "mint_tracked_message",
      arguments: { to: "ada@example.com", text: "Hi Ada" },
    });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(toolText(result as { isError?: boolean; content?: unknown }));
    expect(body.message_id).toBe("msg_test");
    expect(body.pixel_url).toContain("/o/");
    expect(body.raw_mime).toBeUndefined();
    expect(deps.mintTrackedMessage).toHaveBeenCalledOnce();

    const banned = await client.callTool({
      name: "mint_tracked_message",
      arguments: { to: "ada@example.com", text: "Hi", htmlBody: "<p>nope</p>" },
    });
    expect(banned.isError).toBe(true);
    expect(toolText(banned as { isError?: boolean; content?: unknown })).toContain(HTML_BODY_BANNED);
    expect(deps.mintTrackedMessage).toHaveBeenCalledOnce();
  });
});
