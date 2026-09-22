import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CONNECTOR_BAN, SERVER_INSTRUCTIONS } from "./copy";
import type { AmtMcpConfig } from "./config";
import {
  defaultToolDeps,
  getTrackedMessageTool,
  mintTrackedBatchTool,
  mintTrackedMessageTool,
  sendTrackedEmailTool,
  type AmtToolDeps,
} from "./handlers";
import {
  getTrackedMessageSchema,
  mintTrackedBatchSchema,
  mintTrackedMessageSchema,
  sendTrackedEmailSchema,
} from "./schemas";

const VERSION = "0.1.0";

function textResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}

async function runTool(fn: () => Promise<unknown>) {
  try {
    return textResult(await fn());
  } catch (err) {
    return errorResult(err);
  }
}

/**
 * Node MCP bridge over `client/`. The tracking Worker stays mint+track and does not send.
 * SMTP uses the existing Node socket client; mailbox secrets stay in this process env.
 */
export function createAmtMcpServer(config: AmtMcpConfig, deps: AmtToolDeps = defaultToolDeps()): McpServer {
  const server = new McpServer(
    { name: "agent-mail-track", version: VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    "mint_tracked_message",
    {
      title: "Mint tracked message",
      description:
        "POST /v1/messages on the AMT Worker. Returns message_id, pixel_url, and a short raw MIME summary (byte counts and whether the open pixel is present). Set include_raw only when you need raw_mime or raw_base64url. Does not send mail. " +
        CONNECTOR_BAN,
      inputSchema: mintTrackedMessageSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => runTool(() => mintTrackedMessageTool(args, config, deps)),
  );

  server.registerTool(
    "send_tracked_email",
    {
      title: "Send tracked email",
      description:
        "Mint via AMT when raw_mime / raw_base64url are omitted, then send. via=smtp uses SMTP DATA of raw_mime. via=gmail_raw uses Gmail API users.messages.send {raw: raw_base64url}. Requires from. SMTP_* and GMAIL_ACCESS_TOKEN are read from the MCP process env only. " +
        CONNECTOR_BAN,
      inputSchema: sendTrackedEmailSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => runTool(() => sendTrackedEmailTool(args, config, deps)),
  );

  server.registerTool(
    "get_tracked_message",
    {
      title: "Get tracked message",
      description:
        "GET /v1/messages/:id. Returns status, opens, clicks, and the event timeline. Read-only. Does not send mail. " +
        CONNECTOR_BAN,
      inputSchema: getTrackedMessageSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (args) => runTool(() => getTrackedMessageTool(args, config, deps)),
  );

  server.registerTool(
    "mint_tracked_batch",
    {
      title: "Mint tracked batch",
      description:
        "Mint-only batch from CSV text or rows, using the in-repo mailmerge runner. Writes amt_message_id and pixel_url per row. Does not send. Do not invent links when the body has none. " +
        CONNECTOR_BAN,
      inputSchema: mintTrackedBatchSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => runTool(() => mintTrackedBatchTool(args, config, deps)),
  );

  return server;
}
