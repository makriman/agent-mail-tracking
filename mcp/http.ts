#!/usr/bin/env node
/**
 * Local Streamable HTTP MCP. Binds 127.0.0.1 by default.
 *
 *   npm run mcp:http
 *
 * POST /mcp — MCP. GET /health — process check.
 * Set AMT_MCP_HTTP_TOKEN to require Authorization: Bearer.
 * Do not publish this port: the process can send mail with SMTP_* / GMAIL_ACCESS_TOKEN.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadAmtMcpConfig, loadHttpBind, type AmtMcpConfig, type AmtMcpHttpBind } from "./config";
import { defaultToolDeps, type AmtToolDeps } from "./handlers";
import { createAmtMcpServer } from "./server";

function authorized(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  return req.headers.authorization === `Bearer ${token}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

export function startAmtMcpHttp(
  config: AmtMcpConfig,
  bind: AmtMcpHttpBind,
  deps: AmtToolDeps = defaultToolDeps(),
): Promise<Server> {
  if ((bind.host === "0.0.0.0" || bind.host === "::") && !bind.token) {
    console.error(
      "AMT MCP HTTP is reachable beyond localhost without AMT_MCP_HTTP_TOKEN. Set a token or bind 127.0.0.1.",
    );
  }

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "agent-mail-track-mcp" });
      return;
    }
    if (url.pathname !== "/mcp") {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (!authorized(req, bind.token)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    const mcp = createAmtMcpServer(config, deps);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      if (!res.headersSent) sendJson(res, 500, { error: "mcp_error" });
    } finally {
      await transport.close().catch(() => undefined);
      await mcp.close().catch(() => undefined);
    }
  });

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(bind.port, bind.host, () => resolve(httpServer));
  });
}

export async function main(): Promise<void> {
  const config = loadAmtMcpConfig(process.env);
  const bind = loadHttpBind(process.env);
  const server = await startAmtMcpHttp(config, bind);
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : bind.port;
  console.error(`AMT MCP HTTP http://${bind.host}:${port}/mcp`);
}

const invokedDirectly = /mcp\/http\.ts$|mcp\/http$/.test(process.argv[1]?.replace(/\\/g, "/") ?? "");
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
