/**
 * Batch mint (+ optional send) for Researcher GTM cold waves.
 *
 *   npm run send-tracked-batch -- --csv in.csv --out out.csv --mint-only
 *   npm run send-tracked-batch -- --csv in.csv --out out.csv --via smtp
 *
 * Logs every row’s AMT message_id. Does not turn AMT into an MTA.
 * htmlBody is banned. CLI entry: client/batch-cli.ts. Never commit mailbox secrets.
 */
import { HTML_BODY_BANNED, assertNoHtmlBody } from "./guard";
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

export const RESULT_COLUMNS = ["message_id", "pixel_url", "status", "error", "via", "sent_at"] as const;
export const RAW_PATH_COLUMN = "raw_path";

export type BatchStatus = "minted" | "sent" | "error";

/** SMTP mailbox config (send path). Same fields as sendTrackedEmail smtp, minus envelope. */
export type BatchSmtpConfig = Pick<SmtpSendOptions, "host" | "port" | "user" | "pass" | "secure" | "timeoutMs" | "ehloName">;

export const BATCH_USAGE = `Usage: npm run send-tracked-batch -- --csv in.csv --out out.csv [options]

Mint (POST /v1/messages) for every CSV row, optionally send raw MIME.
AMT stays mint+track — this runner is not Postal/an MTA.
Never uses htmlBody (Gmail/Outlook connectors strip the open pixel).

Required:
  --csv <path>            input CSV
  --out <path>            output CSV (input columns + result columns)

Mode:
  --mint-only             mint only; write message_id + pixel_url; do not send
  --via smtp|gmail_raw    mint then send (required unless --mint-only)
  --delay-ms <n>          pause between rows (default 1000)
  --raw-dir <path>        optional: write each raw_mime to <dir>/<message_id>.eml

Input columns (header row):
  to, subject, text       required except text may be omitted when mode=html
  from, mode, html, metadata_json   optional

Output appends:
  message_id, pixel_url, status (minted|sent|error), error, via, sent_at
  raw_path                when --raw-dir is set

Row errors are fail-soft (logged, next row continues). Config errors abort.
Same env as send-tracked: AMT_API_KEY, AMT_BASE_URL, AMT_FROM, SMTP_*, GMAIL_ACCESS_TOKEN.
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

function emptyResult(): Record<string, string> {
  return {
    message_id: "",
    pixel_url: "",
    status: "",
    error: "",
    via: "",
    sent_at: "",
  };
}

function rowHasBannedBody(rec: Record<string, string>): boolean {
  return Boolean(cell(rec, "htmlBody") || cell(rec, "textBody") || cell(rec, "html_body") || cell(rec, "text_body"));
}

async function processRow(
  rec: Record<string, string>,
  opts: RunBatchOptions,
  deps: Required<Pick<BatchRunnerDeps, "mint" | "sendSmtp" | "sendGmail" | "nowIso">> & BatchRunnerDeps,
): Promise<Record<string, string>> {
  const out = emptyResult();
  if (opts.via) out.via = opts.via;

  try {
    assertNoHtmlBody(rec);
    if (rowHasBannedBody(rec)) throw new AmtClientError(HTML_BODY_BANNED);

    const to = cell(rec, "to").trim();
    const from = (cell(rec, "from").trim() || opts.defaultFrom || "").trim() || undefined;
    const subject = cell(rec, "subject") || undefined;
    const text = cell(rec, "text") || undefined;
    const html = cell(rec, "html") || undefined;
    const mode = parseMode(cell(rec, "mode")) ?? opts.defaultMode;
    const metadata = parseMetadataJson(cell(rec, "metadata_json"));

    if (!to.includes("@")) throw new AmtClientError("to must be an email address");
    if ((mode ?? "plain_looking") === "html" ? !html : !text) {
      throw new AmtClientError(mode === "html" ? "missing html for mode=html" : "missing text");
    }
    if (!opts.mintOnly && opts.via === "smtp" && !from) {
      throw new AmtClientError("from is required for SMTP MAIL FROM (column from, --from, or AMT_FROM)");
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

    out.message_id = minted.message_id ?? "";
    out.pixel_url = minted.pixel_url ?? "";

    if (deps.writeRaw && minted.raw_mime) {
      const rawPath = await deps.writeRaw(minted.message_id, minted.raw_mime);
      if (rawPath) out[RAW_PATH_COLUMN] = rawPath;
    }

    if (opts.mintOnly) {
      out.status = "minted";
      out.via = "";
      return out;
    }

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

    out.status = "sent";
    out.via = opts.via;
    out.sent_at = deps.nowIso();
    return out;
  } catch (err) {
    out.status = "error";
    out.error = errorText(err);
    return out;
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

  const extra: string[] = [...RESULT_COLUMNS];
  if (deps.writeRaw) extra.push(RAW_PATH_COLUMN);
  const headers = mergeHeaders(opts.headers, extra);

  const records: Record<string, string>[] = [];
  const summary: BatchSummary = { total: opts.records.length, minted: 0, sent: 0, error: 0 };

  for (let i = 0; i < opts.records.length; i++) {
    const rec = opts.records[i]!;
    const result = await processRow(rec, opts, deps);
    const combined = { ...rec };
    for (const [k, v] of Object.entries(result)) combined[k] = v;
    records.push(combined);
    if (result.status === "minted") summary.minted++;
    else if (result.status === "sent") summary.sent++;
    else summary.error++;
    await opts.onRow?.(combined, i);
    if (i < opts.records.length - 1) await deps.sleep(opts.delayMs);
  }

  return { headers, records, csv: stringifyCsvRecords(headers, records), summary };
}
