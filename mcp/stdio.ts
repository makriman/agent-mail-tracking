#!/usr/bin/env node
/**
 * stdio MCP entry. Agents attach this process.
 *
 *   npm run mcp
 *
 * Env: AMT_API_KEY, AMT_BASE_URL, AMT_FROM, SMTP_*, GMAIL_ACCESS_TOKEN.
 * Never prints secrets. Protocol messages are stdout; logs are stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadAmtMcpConfig } from "./config";
import { createAmtMcpServer } from "./server";

export async function main(): Promise<void> {
  const config = loadAmtMcpConfig(process.env);
  const server = createAmtMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const invokedDirectly = /mcp\/stdio\.ts$|mcp\/stdio$/.test(process.argv[1]?.replace(/\\/g, "/") ?? "");
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
