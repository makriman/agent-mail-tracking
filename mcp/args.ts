import { parseCampaign, parseCsvRecords, parseTouch, type Touch } from "../client/batch";
import { HTML_BODY_BANNED, AmtHtmlBodyError } from "../client/guard";
import { AmtClientError, type Mode, type SendVia } from "../client/types";
import type { AmtMcpConfig } from "./config";

export const BANNED_CONNECTOR_FIELDS = ["htmlBody", "textBody", "html_body", "text_body"] as const;

const BANNED_CONNECTOR_KEYS = new Set(BANNED_CONNECTOR_FIELDS.map((key) => key.toLowerCase()));

const MODES: readonly Mode[] = ["plain_looking", "plain_only", "html"];
const MAX_BATCH_ROWS = 500;
const MAX_CSV_CHARS = 2_000_000;

export function rejectBannedConnectorFields(input: unknown): void {
  if (!input || typeof input !== "object") return;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value == null) continue;
    if (BANNED_CONNECTOR_KEYS.has(key.toLowerCase())) throw new AmtHtmlBodyError(HTML_BODY_BANNED);
  }
}

function asRecord(input: unknown, label = "arguments"): Record<string, unknown> {
  rejectBannedConnectorFields(input);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AmtClientError(`${label} must be an object`);
  }
  return input as Record<string, unknown>;
}

function optionalString(rec: Record<string, unknown>, key: string): string | undefined {
  const value = rec[key];
  if (value == null) return undefined;
  if (typeof value !== "string") throw new AmtClientError(`${key} must be a string`);
  return value;
}

function requireEmail(value: string | undefined, key: string): string {
  const email = value?.trim() ?? "";
  if (!email.includes("@") || email.length > 320 || /[\r\n]/.test(email)) {
    throw new AmtClientError(`${key} must be an email address`);
  }
  return email;
}

function optionalMode(rec: Record<string, unknown>): Mode | undefined {
  const raw = optionalString(rec, "mode");
  if (raw == null || raw === "") return undefined;
  if (!MODES.includes(raw as Mode)) {
    throw new AmtClientError("invalid mode (plain_looking | plain_only | html)");
  }
  return raw as Mode;
}

function optionalMetadata(rec: Record<string, unknown>): Record<string, unknown> | undefined {
  if (rec.metadata == null) return undefined;
  if (typeof rec.metadata !== "object" || Array.isArray(rec.metadata)) {
    throw new AmtClientError("metadata must be an object");
  }
  return rec.metadata as Record<string, unknown>;
}

function optionalBool(rec: Record<string, unknown>, key: string): boolean {
  const value = rec[key];
  if (value == null) return false;
  if (typeof value !== "boolean") throw new AmtClientError(`${key} must be a boolean`);
  return value;
}

export interface MintToolArgs {
  to: string;
  from?: string;
  subject?: string;
  text?: string;
  html?: string;
  mode?: Mode;
  metadata?: Record<string, unknown>;
  webhookUrl?: string;
  trackingBaseUrl?: string;
  includeRaw: boolean;
}

export function parseMintArgs(input: unknown): MintToolArgs {
  const rec = asRecord(input);
  const to = requireEmail(optionalString(rec, "to"), "to");
  const fromRaw = optionalString(rec, "from");
  const from = fromRaw != null && fromRaw !== "" ? requireEmail(fromRaw, "from") : undefined;
  const mode = optionalMode(rec);
  const text = optionalString(rec, "text");
  const html = optionalString(rec, "html");
  if (mode === "html" ? !html?.trim() : !text?.trim()) {
    throw new AmtClientError(mode === "html" ? "html is required for mode=html" : "text is required");
  }
  return {
    to,
    from,
    subject: optionalString(rec, "subject"),
    text,
    html,
    mode,
    metadata: optionalMetadata(rec),
    webhookUrl: optionalString(rec, "webhook_url"),
    trackingBaseUrl: optionalString(rec, "tracking_base_url"),
    includeRaw: optionalBool(rec, "include_raw"),
  };
}

export interface SendToolArgs {
  to: string;
  from: string;
  via: SendVia;
  subject?: string;
  text?: string;
  html?: string;
  mode?: Mode;
  metadata?: Record<string, unknown>;
  webhookUrl?: string;
  trackingBaseUrl?: string;
  messageId?: string;
  rawMime?: string;
  rawBase64url?: string;
  includeRaw: boolean;
}

function resolveVia(raw: string | undefined, config: AmtMcpConfig): SendVia {
  if (raw == null || raw === "") {
    if (config.gmailAccessToken && !config.smtp) return "gmail_raw";
    if (config.smtp) return "smtp";
    throw new AmtClientError("via is required (smtp | gmail_raw); no SMTP_* or GMAIL_ACCESS_TOKEN in env");
  }
  if (raw !== "smtp" && raw !== "gmail_raw") {
    throw new AmtClientError("invalid via (smtp | gmail_raw)");
  }
  return raw;
}

function optionalMessageId(rec: Record<string, unknown>): string | undefined {
  const id = optionalString(rec, "message_id");
  if (id == null || id === "") return undefined;
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new AmtClientError("invalid message_id");
  return id;
}

export function parseSendArgs(input: unknown, config: AmtMcpConfig): SendToolArgs {
  const rec = asRecord(input);
  const to = requireEmail(optionalString(rec, "to"), "to");
  const fromArg = optionalString(rec, "from");
  const from = requireEmail(fromArg && fromArg !== "" ? fromArg : config.defaultFrom, "from");
  const via = resolveVia(optionalString(rec, "via"), config);
  const mode = optionalMode(rec);
  const text = optionalString(rec, "text");
  const html = optionalString(rec, "html");
  const rawMime = optionalString(rec, "raw_mime");
  const rawBase64url = optionalString(rec, "raw_base64url");
  const hasRaw = Boolean(rawMime || rawBase64url);
  if (!hasRaw && (mode === "html" ? !html?.trim() : !text?.trim())) {
    throw new AmtClientError(
      mode === "html"
        ? "html is required for mode=html (or pass raw_mime / raw_base64url from mint_tracked_message)"
        : "text is required (or pass raw_mime / raw_base64url from mint_tracked_message)",
    );
  }
  return {
    to,
    from,
    via,
    subject: optionalString(rec, "subject"),
    text,
    html,
    mode,
    metadata: optionalMetadata(rec),
    webhookUrl: optionalString(rec, "webhook_url"),
    trackingBaseUrl: optionalString(rec, "tracking_base_url"),
    messageId: optionalMessageId(rec),
    rawMime,
    rawBase64url,
    includeRaw: optionalBool(rec, "include_raw"),
  };
}

export function parseGetArgs(input: unknown): { messageId: string } {
  const rec = asRecord(input);
  const messageId = optionalMessageId(rec);
  if (!messageId) throw new AmtClientError("message_id is required");
  return { messageId };
}

export interface BatchToolArgs {
  headers: string[];
  records: Record<string, string>[];
  from: string;
  touch: Touch | "";
  campaign: string;
  delayMs: number;
  mode?: Mode;
  includeCsv: boolean;
  webhookUrl?: string;
  trackingBaseUrl?: string;
}

function stringifyCell(value: unknown, key: string): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  throw new AmtClientError(`row field ${key} must be a string`);
}

function recordsFromRows(rows: unknown): { headers: string[]; records: Record<string, string>[] } {
  if (!Array.isArray(rows)) throw new AmtClientError("rows must be an array");
  const headers: string[] = [];
  const seen = new Set<string>();
  const records: Record<string, string>[] = [];
  for (const row of rows) {
    rejectBannedConnectorFields(row);
    const rec = asRecord(row, "row");
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(rec)) {
      const header = key.trim();
      if (!header) throw new AmtClientError("row has an empty field name");
      if (!seen.has(header.toLowerCase())) {
        seen.add(header.toLowerCase());
        headers.push(header);
      }
      out[header] = stringifyCell(value, header);
    }
    records.push(out);
  }
  return { headers, records };
}

export function parseBatchArgs(input: unknown, config: AmtMcpConfig): BatchToolArgs {
  const rec = asRecord(input);
  const csv = optionalString(rec, "csv");
  const hasRows = rec.rows != null;
  if (Boolean(csv) === hasRows) {
    throw new AmtClientError("pass csv or rows, not both");
  }
  if (csv && csv.length > MAX_CSV_CHARS) throw new AmtClientError("csv is too large");

  let headers: string[];
  let records: Record<string, string>[];
  if (csv != null) {
    const parsed = parseCsvRecords(csv);
    headers = parsed.headers;
    records = parsed.records;
    for (const row of records) rejectBannedConnectorFields(row);
  } else {
    const parsed = recordsFromRows(rec.rows);
    headers = parsed.headers;
    records = parsed.records;
  }
  if (records.length === 0) throw new AmtClientError("batch has no rows");
  if (records.length > MAX_BATCH_ROWS) {
    throw new AmtClientError(`batch is limited to ${MAX_BATCH_ROWS} rows`);
  }

  const fromArg = optionalString(rec, "from");
  const from = requireEmail(fromArg && fromArg !== "" ? fromArg : config.defaultFrom, "from");
  const touchRaw = optionalString(rec, "touch");
  const touch = touchRaw ? parseTouch(touchRaw) : "";
  const delayMs = parseToolDelay(rec.delay_ms);

  return {
    headers,
    records,
    from,
    touch,
    campaign: parseCampaign(optionalString(rec, "campaign")),
    delayMs,
    mode: optionalMode(rec),
    includeCsv: optionalBool(rec, "include_csv"),
    webhookUrl: optionalString(rec, "webhook_url"),
    trackingBaseUrl: optionalString(rec, "tracking_base_url"),
  };
}

function parseToolDelay(raw: unknown): number {
  if (raw == null) return 1000;
  if (typeof raw !== "number" && typeof raw !== "string") {
    throw new AmtClientError("delay_ms must be a number");
  }
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 60_000) {
    throw new AmtClientError("delay_ms must be an integer from 0 to 60000");
  }
  return n;
}
