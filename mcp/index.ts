export { OPEN_TRACKING_INSTRUCTION, CONNECTOR_BAN, SERVER_INSTRUCTIONS } from "./copy";
export { loadAmtMcpConfig, loadHttpBind } from "./config";
export type { AmtMcpConfig, AmtMcpHttpBind, SmtpEnvConfig } from "./config";
export {
  mintTrackedMessageTool,
  sendTrackedEmailTool,
  getTrackedMessageTool,
  mintTrackedBatchTool,
  defaultToolDeps,
} from "./handlers";
export type { AmtToolDeps, SendToolResult, BatchToolResult } from "./handlers";
export { createAmtMcpServer } from "./server";
export { startAmtMcpHttp } from "./http";
