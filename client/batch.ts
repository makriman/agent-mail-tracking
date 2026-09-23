/**
 * Batch mint (+ optional send) for eSlams Researcher GTM cold waves (prepare-only first).
 *
 *   npm run send-tracked-batch -- --csv MAILMERGE-E1.csv --out amt-log-e1.csv --mint-only --touch E1 --from makriman@berkeley.edu
 *
 * Mailmerge input: send_batch_order,contact_id,first_name,email,subject,body_text
 * Map: email→to, body_text→text (plain_looking), subject→subject. Do not invent links.
 * htmlBody is banned. CLI: client/batch-cli.ts. Never commit mailbox secrets.
 */
import { HTML_BODY_BANNED, assertNoHtmlBody, assertSendableRawMime } from "./guard";
import { mintTrackedMessage } from "./mint";
import {
  AmtClientError,
  type GmailAuth,
  type GmailSendResult,
  type MintedMessage,
  type MintTrackedMessageOptions,
  type Mode,
  type SendVia,
  type SmtpSendOptions,
  type SmtpSendResult,
} from "./types";

export const DEFAULT_CAMPAIGN = "eslams-researcher-lowstakes-2026-09";
export const TOUCHES = ["E1", "E2", "E3"] as const;
export type Touch = (typeof TOUCHES)[number];

/** eSlams mailmerge send sheet (shared box: /workspace/eslams-outbound-500/MAILMERGE-E1.csv). */
export const MAILMERGE_COLUMNS = [
  "send_batch_order",
  "contact_id",
  "first_name",
  "email",
  "subject",
  "body_text",
] as const;

/** Handoff log columns (keep all input cols, then append these). */
export const LOG_COLUMNS = [
  "campaign",
  "touch",
  "amt_message_id",
  "sent_at",
  "open_status",
  "open_at",
  "bounce_or_error",
] as const;

export const RESULT_COLUMNS = LOG_COLUMNS;
export const RAW_PATH_COLUMN = "raw_path";
export const PIXEL_URL_COLUMN = "pixel_url";

export type BatchStatus = "minted" | "sent" | "error";

/** SMTP mailbox config (send path). Same fields as sendTrackedEmail smtp, minus envelope. */
export type BatchSmtpConfig = Pick<SmtpSendOptions, "host" | "port" | "user" | "pass" | "secure" | "timeoutMs" | "ehloName">;

export const BATCH_USAGE = `Usage: npm run send-tracked-batch -- --csv MAILMERGE-E1.csv --out amt-log-e1.csv [options]

eSlams Researcher GTM prepare: mint AMT message_ids for a mailmerge sheet. No send.
AMT stays mint+track — this runner is not Postal/an MTA.
Never uses htmlBody. Bodies have no URLs — do not invent links (click tracking N/A).

Required:
  --csv <path>            mailmerge CSV (e.g. /workspace/eslams-outbound-500/MAILMERGE-E1.csv)
  --out <path>            log CSV (input columns + handoff columns)
  --touch E1|E2|E3
  --from <email>          or AMT_FROM (e.g. makriman@berkeley.edu)

Prepare:
  --mint-only             mint only; write amt_message_id; do not SMTP/Gmail send
  --campaign <slug>       default eslams-researcher-lowstakes-2026-09
  --delay-ms <n>          pause between rows (default 1000)
  --raw-dir <path>        optional: write each raw_mime to <dir>/<message_id>.eml
  --via smtp|gmail_raw    mint then send (omit when --mint-only)

Mailmerge columns:
  send_batch_order,contact_id,first_name,email,subject,body_text
  Map: email→to, body_text→text (mode=plain_looking), subject→subject

Log CSV appends:
  campaign, touch, amt_message_id, sent_at, open_status, open_at, bounce_or_error
  (open_status / open_at stay empty at prepare; Sheet sync later)

Row errors are fail-soft (bounce_or_error, next row continues). Config errors abort.
Env: AMT_API_KEY, AMT_BASE_URL, AMT_FROM, SMTP_*, GMAIL_ACCESS_TOKEN.
Do not put mailbox passwords or OAuth tokens in git or Worker secrets.
`;

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const s = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
        continue;
      }
      field += c;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (c === "\n") {
      row.push(field);
      field = "";
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
      continue;
    }
    if (c === "\r") continue;
    field += c;
  }
  if (inQuotes) throw new AmtClientError("csv: unterminated quoted field");
  row.push(field);
  if (row.some((cell) => cell !== "")) rows.push(row);
  return rows;
}

export function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function stringifyCsv(rows: string[][]): string {
  if (rows.length === 0) return "";
  return rows.map((r) => r.map((c) => csvEscape(c ?? "")).join(",")).join("\n") + "\n";
}

export function parseCsvRecords(text: string): { headers: string[]; records: Record<string, string>[] } {
  const table = parseCsv(text);
  if (table.length === 0) throw new AmtClientError("csv: missing header row");
  const headers = table[0]!.map((h) => h.trim());
  if (headers.some((h) => h === "")) throw new AmtClientError("csv: empty header");
  const seen = new Set<string>();
  for (const h of headers) {
    const key = h.toLowerCase();
    if (seen.has(key)) throw new AmtClientError(`csv: duplicate header ${h}`);
    seen.add(key);
  }
  const records: Record<string, string>[] = [];
  for (const r of table.slice(1)) {
    if (!r.some((c) => c.trim() !== "")) continue;
    const rec: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) rec[headers[i]!] = r[i] ?? "";
    records.push(rec);
  }
  return { headers, records };
}

export function mergeHeaders(inputHeaders: string[], extra: readonly string[]): string[] {
  const out = [...inputHeaders];
  const have = new Set(out.map((h) => h.toLowerCase()));
  for (const col of extra) {
    if (!have.has(col.toLowerCase())) {
      out.push(col);
      have.add(col.toLowerCase());
    }
  }
  return out;
}

export function stringifyCsvRecords(headers: string[], records: Record<string, string>[]): string {
  return stringifyCsv([headers, ...records.map((rec) => headers.map((h) => rec[h] ?? ""))]);
}

export function cell(rec: Record<string, string>, name: string): string {
  if (Object.prototype.hasOwnProperty.call(rec, name)) return rec[name] ?? "";
  const found = Object.keys(rec).find((k) => k.toLowerCase() === name.toLowerCase());
  return found ? (rec[found] ?? "") : "";
}

export function parseDelayMs(raw: string | undefined, fallback = 1000): number {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new AmtClientError("invalid --delay-ms (expected >= 0)");
  return n;
}

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function parseTouch(raw: string | undefined): Touch {
  const v = (raw ?? "").trim().toUpperCase();
  if (v !== "E1" && v !== "E2" && v !== "E3") {
    throw new AmtClientError("invalid --touch (E1 | E2 | E3)");
  }
  return v;
}

export function parseCampaign(raw: string | undefined): string {
  const v = (raw ?? "").trim();
  return v || DEFAULT_CAMPAIGN;
}

/** Mailmerge: email→to, body_text→text. Legacy: to / text still accepted. */
export function resolveRecipient(rec: Record<string, string>): string {
  return (cell(rec, "email") || cell(rec, "to")).trim();
}

export function resolveBodyText(rec: Record<string, string>): string {
  return cell(rec, "body_text") || cell(rec, "text");
}

function parseMetadataJson(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new AmtClientError("metadata_json is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AmtClientError("metadata_json must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function parseMode(raw: string): Mode | undefined {
  const v = raw.trim();
  if (!v) return undefined;
  if (v !== "plain_looking" && v !== "plain_only" && v !== "html") {
    throw new AmtClientError("invalid mode (plain_looking | plain_only | html)");
  }
  return v;
}

async function sendNotConfigured(): Promise<never> {
  throw new AmtClientError("send transport not configured (pass deps.sendSmtp / deps.sendGmail, or use --mint-only)");
}

export interface BatchRunnerDeps {
  mint?: (opts: MintTrackedMessageOptions) => Promise<MintedMessage>;
  sendSmtp?: (opts: SmtpSendOptions) => Promise<SmtpSendResult>;
  sendGmail?: (auth: GmailAuth, rawBase64url: string) => Promise<GmailSendResult>;
  sleep?: (ms: number) => Promise<void>;
  nowIso?: () => string;
  writeRaw?: (messageId: string, rawMime: string) => Promise<string | undefined>;
}

export interface RunBatchOptions {
  records: Record<string, string>[];
  headers: string[];
  mintOnly: boolean;
  via?: SendVia | "";
  delayMs: number;
  defaultFrom?: string;
  defaultMode?: Mode;
  campaign?: string;
  touch?: string;
  baseUrl: string;
  apiKey: string;
  smtp?: BatchSmtpConfig;
  gmail?: GmailAuth;
  trackingBaseUrl?: string;
  webhookUrl?: string;
  deps?: BatchRunnerDeps;
  onRow?: (combined: Record<string, string>, index: number) => void | Promise<void>;
}

export interface BatchSummary {
  total: number;
  minted: number;
  sent: number;
  error: number;
}

export interface BatchRunResult {
  headers: string[];
  records: Record<string, string>[];
  csv: string;
  summary: BatchSummary;
}

function emptyResult(opts: RunBatchOptions): Record<string, string> {
  return {
    campaign: parseCampaign(opts.campaign),
    touch: opts.touch ?? "",
    amt_message_id: "",
    sent_at: "",
    open_status: "",
    open_at: "",
    bounce_or_error: "",
    pixel_url: "",
  };
}

function rowHasBannedBody(rec: Record<string, string>): boolean {
  return Boolean(cell(rec, "htmlBody") || cell(rec, "textBody") || cell(rec, "html_body") || cell(rec, "text_body"));
}

async function processRow(
  rec: Record<string, string>,
  opts: RunBatchOptions,
  deps: Required<Pick<BatchRunnerDeps, "mint" | "sendSmtp" | "sendGmail" | "nowIso">> & BatchRunnerDeps,
): Promise<Record<string, string> & { _status: BatchStatus }> {
  const out = emptyResult(opts);

  try {
    assertNoHtmlBody(rec);
    if (rowHasBannedBody(rec)) throw new AmtClientError(HTML_BODY_BANNED);

    const to = resolveRecipient(rec);
    const from = (cell(rec, "from").trim() || opts.defaultFrom || "").trim() || undefined;
    const subject = cell(rec, "subject") || undefined;
    const text = resolveBodyText(rec) || undefined;
    const html = cell(rec, "html") || undefined;
    const mode = parseMode(cell(rec, "mode")) ?? opts.defaultMode ?? "plain_looking";
    const extraMeta = parseMetadataJson(cell(rec, "metadata_json"));
    const campaign = parseCampaign(opts.campaign);
    const touch = opts.touch ?? "";
    const metadata: Record<string, unknown> = {
      ...extraMeta,
      campaign,
      ...(touch ? { touch } : {}),
      contact_id: cell(rec, "contact_id") || undefined,
      send_batch_order: cell(rec, "send_batch_order") || undefined,
    };
    for (const [k, v] of Object.entries(metadata)) {
      if (v === undefined || v === "") delete metadata[k];
    }

    if (!to.includes("@")) throw new AmtClientError("email/to must be an email address");
    if (mode === "html" ? !html : !text) {
      throw new AmtClientError(mode === "html" ? "missing html for mode=html" : "missing body_text/text");
    }
    if (!opts.mintOnly && opts.via === "smtp" && !from) {
      throw new AmtClientError("from is required for SMTP MAIL FROM (--from or AMT_FROM, e.g. makriman@berkeley.edu)");
    }

    const minted = await deps.mint({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      to,
      from,
      subject,
      text,
      html,
      mode,
      metadata,
      webhookUrl: opts.webhookUrl,
      trackingBaseUrl: opts.trackingBaseUrl,
    });

    out.amt_message_id = minted.message_id ?? "";
    out.pixel_url = minted.pixel_url ?? "";
    out.campaign = campaign;
    if (touch) out.touch = touch;

    if (deps.writeRaw && minted.raw_mime) {
      const rawPath = await deps.writeRaw(minted.message_id, minted.raw_mime);
      if (rawPath) out[RAW_PATH_COLUMN] = rawPath;
    }

    if (opts.mintOnly) {
      return { ...out, _status: "minted" };
    }

    assertSendableRawMime(minted);

    if (opts.via === "smtp") {
      if (!opts.smtp) throw new AmtClientError("smtp config required (host, port, user, pass)");
      const mailFrom = from || minted.from;
      if (!mailFrom) throw new AmtClientError("from is required for SMTP MAIL FROM (pass from when minting)");
      await deps.sendSmtp({
        host: opts.smtp.host,
        port: opts.smtp.port,
        user: opts.smtp.user,
        pass: opts.smtp.pass,
        secure: opts.smtp.secure,
        timeoutMs: opts.smtp.timeoutMs,
        ehloName: opts.smtp.ehloName,
        from: mailFrom,
        to,
        rawMime: minted.raw_mime,
      });
    } else if (opts.via === "gmail_raw") {
      if (!opts.gmail) throw new AmtClientError("gmail auth required (accessToken or googleauth with gmail.send scope)");
      await deps.sendGmail(opts.gmail, minted.raw_base64url);
    } else {
      throw new AmtClientError("invalid_via: expected smtp | gmail_raw, or pass --mint-only");
    }

    out.sent_at = deps.nowIso();
    return { ...out, _status: "sent" };
  } catch (err) {
    out.bounce_or_error = errorText(err);
    return { ...out, _status: "error" };
  }
}

export async function runBatch(opts: RunBatchOptions): Promise<BatchRunResult> {
  const deps = {
    mint: opts.deps?.mint ?? mintTrackedMessage,
    sendSmtp: opts.deps?.sendSmtp ?? sendNotConfigured,
    sendGmail: opts.deps?.sendGmail ?? sendNotConfigured,
    sleep: opts.deps?.sleep ?? sleep,
    nowIso: opts.deps?.nowIso ?? (() => new Date().toISOString()),
    writeRaw: opts.deps?.writeRaw,
  };

  const extra: string[] = [...LOG_COLUMNS, PIXEL_URL_COLUMN];
  if (deps.writeRaw) extra.push(RAW_PATH_COLUMN);
  const headers = mergeHeaders(opts.headers, extra);

  const records: Record<string, string>[] = [];
  const summary: BatchSummary = { total: opts.records.length, minted: 0, sent: 0, error: 0 };

  for (let i = 0; i < opts.records.length; i++) {
    const rec = opts.records[i]!;
    const result = await processRow(rec, opts, deps);
    const { _status, ...fields } = result;
    const combined = { ...rec };
    for (const [k, v] of Object.entries(fields)) combined[k] = v;
    records.push(combined);
    if (_status === "minted") summary.minted++;
    else if (_status === "sent") summary.sent++;
    else summary.error++;
    await opts.onRow?.(combined, i);
    if (i < opts.records.length - 1) await deps.sleep(opts.delayMs);
  }

  return { headers, records, csv: stringifyCsvRecords(headers, records), summary };
}
