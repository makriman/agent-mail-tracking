import { AmtClientError } from "../client/types";

export interface SmtpEnvConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  secure: boolean;
}

/** Resolved AMT + mailbox settings. Passwords and tokens are never returned by tools. */
export interface AmtMcpConfig {
  baseUrl: string;
  apiKey: string;
  defaultFrom?: string;
  smtp?: SmtpEnvConfig;
  gmailAccessToken?: string;
}

export interface AmtMcpHttpBind {
  host: string;
  port: number;
  /** When set, POST /mcp requires Authorization: Bearer <token>. */
  token?: string;
}

export type EnvLike = Record<string, string | undefined>;

function trimmed(env: EnvLike, key: string): string | undefined {
  const value = env[key];
  if (value == null) return undefined;
  const next = value.trim();
  return next.length > 0 ? next : undefined;
}

export function loadAmtMcpConfig(env: EnvLike): AmtMcpConfig {
  const apiKey = trimmed(env, "AMT_API_KEY");
  if (!apiKey) throw new AmtClientError("AMT_API_KEY is required");

  const baseUrl = (trimmed(env, "AMT_BASE_URL") ?? "https://track.greatindiancompany.com").replace(/\/+$/, "");
  const defaultFrom = trimmed(env, "AMT_FROM");
  const gmailAccessToken = trimmed(env, "GMAIL_ACCESS_TOKEN");
  const smtp = loadSmtp(env);

  return {
    baseUrl,
    apiKey,
    ...(defaultFrom ? { defaultFrom } : {}),
    ...(smtp ? { smtp } : {}),
    ...(gmailAccessToken ? { gmailAccessToken } : {}),
  };
}

function loadSmtp(env: EnvLike): SmtpEnvConfig | undefined {
  const host = trimmed(env, "SMTP_HOST");
  const user = trimmed(env, "SMTP_USER");
  const passRaw = env.SMTP_PASS;
  const pass = passRaw == null ? undefined : passRaw;
  const portRaw = trimmed(env, "SMTP_PORT");
  const any = Boolean(host || user || portRaw || (pass != null && pass !== ""));
  if (!any) return undefined;
  if (!host || !user || pass == null || pass === "") {
    throw new AmtClientError("SMTP requires SMTP_HOST, SMTP_USER, and SMTP_PASS together");
  }
  const port = Number(portRaw ?? "587");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AmtClientError("invalid SMTP_PORT");
  }
  const secureFlag = trimmed(env, "SMTP_SECURE");
  const secure = secureFlag === "1" || secureFlag === "true" || port === 465;
  return { host, port, user, pass, secure };
}

export function loadHttpBind(env: EnvLike): AmtMcpHttpBind {
  const host = trimmed(env, "AMT_MCP_HTTP_HOST") ?? "127.0.0.1";
  const portRaw = trimmed(env, "AMT_MCP_HTTP_PORT") ?? "3333";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AmtClientError("invalid AMT_MCP_HTTP_PORT");
  }
  const token = trimmed(env, "AMT_MCP_HTTP_TOKEN");
  return { host, port, ...(token ? { token } : {}) };
}
