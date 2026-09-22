import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { startAmtMcpHttp } from "./http";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        }),
    ),
  );
});

function portOf(server: Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  return address.port;
}

describe("MCP HTTP", () => {
  it("serves health on localhost and requires the bearer token for /mcp", async () => {
    const server = await startAmtMcpHttp(
      { baseUrl: "https://track.example", apiKey: "k-test" },
      { host: "127.0.0.1", port: 0, token: "tok" },
    );
    servers.push(server);
    const port = portOf(server);
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(await health.json()).toEqual({ ok: true, service: "agent-mail-track-mcp" });

    const denied = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(denied.status).toBe(401);

    const missing = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(missing.status).toBe(404);

    const init = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer tok",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "amt-http-test", version: "0" },
        },
      }),
    });
    expect(init.status).toBe(200);
    const payload = (await init.json()) as { result?: { serverInfo?: { name?: string }; instructions?: string } };
    expect(payload.result?.serverInfo?.name).toBe("agent-mail-track");
    expect(payload.result?.instructions).toContain("send_tracked_email");
  });
});
