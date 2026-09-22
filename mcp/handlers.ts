import { runBatch, sleep } from "../client/batch";
import { getTrackedMessage } from "../client/get";
import { sendRawGmail } from "../client/gmail";
import { mintTrackedMessage } from "../client/mint";
import { sendTrackedEmail } from "../client/send";
import { sendRawMimeSmtp } from "../client/smtp";
import { AmtClientError, type GmailSendResult, type MintedMessage, type SmtpSendResult } from "../client/types";
import { parseBatchArgs, parseGetArgs, parseMintArgs, parseSendArgs } from "./args";
import type { AmtMcpConfig } from "./config";
import { utf8FromBase64Url, utf8ToBase64Url } from "./raw";
import { rawMimeSummary, summarizeMinted, type MintToolSummary, type RawMimeSummary } from "./summary";

export interface AmtToolDeps {
  mintTrackedMessage: typeof mintTrackedMessage;
  sendTrackedEmail: typeof sendTrackedEmail;
  getTrackedMessage: typeof getTrackedMessage;
  sendRawMimeSmtp: typeof sendRawMimeSmtp;
  sendRawGmail: typeof sendRawGmail;
  runBatch: typeof runBatch;
  sleep: (ms: number) => Promise<void>;
}

export function defaultToolDeps(): AmtToolDeps {
  return {
    mintTrackedMessage,
    sendTrackedEmail,
    getTrackedMessage,
    sendRawMimeSmtp,
    sendRawGmail,
    runBatch,
    sleep,
  };
}

export interface SendToolResult {
  message_id: string | null;
  minted: boolean;
  via: "smtp" | "gmail_raw";
  to: string;
  from: string;
  pixel_url: string | null;
  open_tracking: boolean | null;
  status: string | null;
  raw: RawMimeSummary | null;
  smtp?: { accepted: true; response: string };
  gmail?: GmailSendResult;
  raw_mime?: string;
  raw_base64url?: string;
}

function requireSmtp(config: AmtMcpConfig) {
  if (!config.smtp) {
    throw new AmtClientError(
      "smtp requires SMTP_HOST, SMTP_USER, and SMTP_PASS in the MCP process env. Do not pass mailbox passwords as tool arguments.",
    );
  }
  return config.smtp;
}

function requireGmailToken(config: AmtMcpConfig): string {
  if (!config.gmailAccessToken) {
    throw new AmtClientError(
      "gmail_raw requires GMAIL_ACCESS_TOKEN in the MCP process env (OAuth scope gmail.send). Do not pass the token as a tool argument.",
    );
  }
  return config.gmailAccessToken;
}

function resolveRawPair(rawMime: string | undefined, rawBase64url: string | undefined): {
  rawMime: string;
  rawBase64url: string;
} {
  if (rawMime && rawBase64url) return { rawMime, rawBase64url };
  if (rawMime) return { rawMime, rawBase64url: utf8ToBase64Url(rawMime) };
  if (rawBase64url) return { rawMime: utf8FromBase64Url(rawBase64url), rawBase64url };
  throw new AmtClientError("raw_mime or raw_base64url is required to send without minting");
}

export async function mintTrackedMessageTool(
  input: unknown,
  config: AmtMcpConfig,
  deps: AmtToolDeps = defaultToolDeps(),
): Promise<MintToolSummary> {
  const args = parseMintArgs(input);
  const minted = await deps.mintTrackedMessage({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    to: args.to,
    from: args.from,
    subject: args.subject,
    text: args.text,
    html: args.html,
    mode: args.mode,
    metadata: args.metadata,
    webhookUrl: args.webhookUrl,
    trackingBaseUrl: args.trackingBaseUrl,
  });
  return summarizeMinted(minted, args.includeRaw);
}

export async function sendTrackedEmailTool(
  input: unknown,
  config: AmtMcpConfig,
  deps: AmtToolDeps = defaultToolDeps(),
): Promise<SendToolResult> {
  const args = parseSendArgs(input, config);
  if (args.rawMime || args.rawBase64url) {
    const raw = resolveRawPair(args.rawMime, args.rawBase64url);
    const sent = await deliverRaw(args.via, args.from, args.to, raw.rawMime, raw.rawBase64url, config, deps);
    const result: SendToolResult = {
      message_id: args.messageId ?? null,
      minted: false,
      via: args.via,
      to: args.to,
      from: args.from,
      pixel_url: null,
      open_tracking: null,
      status: null,
      raw: rawMimeSummary(raw.rawMime, raw.rawBase64url),
      ...sent,
    };
    if (args.includeRaw) {
      result.raw_mime = raw.rawMime;
      result.raw_base64url = raw.rawBase64url;
    }
    return result;
  }

  const sent = await deps.sendTrackedEmail({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    to: args.to,
    from: args.from,
    subject: args.subject,
    text: args.text,
    html: args.html,
    mode: args.mode,
    metadata: args.metadata,
    webhookUrl: args.webhookUrl,
    trackingBaseUrl: args.trackingBaseUrl,
    via: args.via,
    ...(args.via === "smtp" ? { smtp: requireSmtp(config) } : {}),
    ...(args.via === "gmail_raw" ? { gmail: { accessToken: requireGmailToken(config) } } : {}),
  });
  const summary = summarizeMinted(sent.minted, false);
  const result: SendToolResult = {
    message_id: sent.minted.message_id,
    minted: true,
    via: args.via,
    to: args.to,
    from: args.from,
    pixel_url: summary.pixel_url,
    open_tracking: summary.open_tracking,
    status: summary.status,
    raw: summary.raw,
    ...(sent.smtp ? { smtp: { accepted: sent.smtp.accepted, response: sent.smtp.response } } : {}),
    ...(sent.gmail ? { gmail: sent.gmail } : {}),
  };
  return attachSendRaw(result, args.includeRaw, sent.minted);
}

function attachSendRaw(result: SendToolResult, includeRaw: boolean, minted: MintedMessage): SendToolResult {
  if (!includeRaw) return result;
  return { ...result, raw_mime: minted.raw_mime, raw_base64url: minted.raw_base64url };
}

async function deliverRaw(
  via: "smtp" | "gmail_raw",
  from: string,
  to: string,
  rawMime: string,
  rawBase64url: string,
  config: AmtMcpConfig,
  deps: AmtToolDeps,
): Promise<Pick<SendToolResult, "smtp" | "gmail">> {
  if (via === "smtp") {
    const smtp = requireSmtp(config);
    const result: SmtpSendResult = await deps.sendRawMimeSmtp({
      host: smtp.host,
      port: smtp.port,
      user: smtp.user,
      pass: smtp.pass,
      secure: smtp.secure,
      from,
      to,
      rawMime,
    });
    return { smtp: { accepted: result.accepted, response: result.response } };
  }
  const gmail = await deps.sendRawGmail({ accessToken: requireGmailToken(config) }, rawBase64url);
  return { gmail };
}

export async function getTrackedMessageTool(
  input: unknown,
  config: AmtMcpConfig,
  deps: AmtToolDeps = defaultToolDeps(),
) {
  const args = parseGetArgs(input);
  return deps.getTrackedMessage({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    messageId: args.messageId,
  });
}

export interface BatchToolResult {
  mint_only: true;
  summary: { total: number; minted: number; sent: number; error: number };
  rows: {
    email: string;
    subject: string;
    amt_message_id: string;
    pixel_url: string;
    bounce_or_error: string;
    campaign: string;
    touch: string;
  }[];
  csv?: string;
}

export async function mintTrackedBatchTool(
  input: unknown,
  config: AmtMcpConfig,
  deps: AmtToolDeps = defaultToolDeps(),
): Promise<BatchToolResult> {
  const args = parseBatchArgs(input, config);
  const result = await deps.runBatch({
    records: args.records,
    headers: args.headers,
    mintOnly: true,
    via: "",
    delayMs: args.delayMs,
    defaultFrom: args.from,
    defaultMode: args.mode,
    campaign: args.campaign,
    touch: args.touch,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    webhookUrl: args.webhookUrl,
    trackingBaseUrl: args.trackingBaseUrl,
    deps: {
      mint: deps.mintTrackedMessage,
      sleep: deps.sleep,
      sendSmtp: async () => {
        throw new AmtClientError("mint_tracked_batch is mint-only and does not send");
      },
      sendGmail: async () => {
        throw new AmtClientError("mint_tracked_batch is mint-only and does not send");
      },
    },
  });
  if (result.summary.sent !== 0) {
    throw new AmtClientError("mint_tracked_batch must not send");
  }
  const rows = result.records.map((row) => ({
    email: row.email || row.to || "",
    subject: row.subject || "",
    amt_message_id: row.amt_message_id || "",
    pixel_url: row.pixel_url || "",
    bounce_or_error: row.bounce_or_error || "",
    campaign: row.campaign || "",
    touch: row.touch || "",
  }));
  return {
    mint_only: true,
    summary: result.summary,
    rows,
    ...(args.includeCsv ? { csv: result.csv } : {}),
  };
}
