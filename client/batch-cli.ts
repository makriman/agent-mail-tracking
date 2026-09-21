#!/usr/bin/env node
/**
 * CLI for client/batch.ts — Researcher GTM mint-only prepare / mint+send waves.
 *
 *   npm run send-tracked-batch -- --csv in.csv --out out.csv --mint-only
 *
 * Never htmlBody. Never commit mailbox secrets.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  BATCH_USAGE,
  RAW_PATH_COLUMN,
  RESULT_COLUMNS,
  cell,
  errorText,
  mergeHeaders,
  parseCsvRecords,
  parseDelayMs,
  runBatch,
  stringifyCsv,
} from "./batch";
import { parseArgs } from "./cli";
import { HTML_BODY_BANNED } from "./guard";
import { sendRawGmail } from "./gmail";
import { sendRawMimeSmtp } from "./smtp";
import type { SmtpTransport } from "./send";
import { type GmailAuth, type Mode, type SendVia } from "./types";

async function writeRawToDir(dir: string, messageId: string, rawMime: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const safe = messageId.replace(/[^A-Za-z0-9._-]+/g, "_") || "message";
  const filePath = path.join(dir, `${safe}.eml`);
  await fs.writeFile(filePath, rawMime, "utf8");
  return filePath;
}

type Flags = Record<string, string | boolean | undefined>;

function str(flags: Flags, key: string, envName?: string): string | undefined {
  const v = flags[key];
  if (typeof v === "string" && v.length > 0) return v;
  if (envName) {
    const env = process.env[envName];
    if (env) return env;
  }
  return undefined;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let flags: Flags;
  try {
    flags = parseArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return 1;
  }

  if (flags.help) {
    console.log(BATCH_USAGE);
    return 0;
  }

  if (flags.htmlBody != null || flags["html-body"] != null || flags.textBody != null) {
    console.error(HTML_BODY_BANNED);
    return 1;
  }

  const csvPath = str(flags, "csv");
  const outPath = str(flags, "out");
  if (!csvPath || !outPath) {
    console.error("missing --csv and/or --out\n");
    console.error(BATCH_USAGE);
    return 1;
  }

  const mintOnly = flags["mint-only"] === true || flags["mint-only"] === "true" || flags["mint-only"] === "1";
  const apiKey = str(flags, "api-key", "AMT_API_KEY");
  const baseUrl = str(flags, "base-url", "AMT_BASE_URL") ?? "https://track.greatindiancompany.com";
  const defaultFrom =
    str(flags, "from", "AMT_FROM") ?? (process.env.SMTP_USER?.includes("@") ? process.env.SMTP_USER : undefined);
  const defaultMode = str(flags, "mode") as Mode | undefined;
  const rawDir = str(flags, "raw-dir");

  let via = str(flags, "via") as SendVia | undefined;
  if (!mintOnly && !via) {
    via = process.env.GMAIL_ACCESS_TOKEN && !process.env.SMTP_HOST ? "gmail_raw" : "smtp";
  }

  if (!apiKey) {
    console.error("missing AMT_API_KEY (or --api-key)");
    return 1;
  }
  if (defaultMode && defaultMode !== "plain_looking" && defaultMode !== "plain_only" && defaultMode !== "html") {
    console.error("invalid --mode (plain_looking | plain_only | html)");
    return 1;
  }
  if (!mintOnly && via !== "smtp" && via !== "gmail_raw") {
    console.error("invalid --via (smtp | gmail_raw) — or pass --mint-only");
    return 1;
  }

  let delayMs: number;
  try {
    delayMs = parseDelayMs(str(flags, "delay-ms"));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return 1;
  }

  let smtp: SmtpTransport | undefined;
  let gmail: GmailAuth | undefined;

  if (!mintOnly && via === "smtp") {
    const host = str(flags, "smtp-host", "SMTP_HOST");
    const portRaw = str(flags, "smtp-port", "SMTP_PORT") ?? "587";
    const user = str(flags, "smtp-user", "SMTP_USER");
    const pass = str(flags, "smtp-pass", "SMTP_PASS");
    const secureFlag = flags["smtp-secure"];
    const secureEnv = process.env.SMTP_SECURE;
    if (!host || !user || pass == null) {
      console.error("SMTP requires SMTP_HOST, SMTP_USER, SMTP_PASS (or --smtp-host/user/pass)");
      return 1;
    }
    const port = Number(portRaw);
    const secure =
      secureFlag === true ||
      secureFlag === "1" ||
      secureFlag === "true" ||
      secureEnv === "1" ||
      secureEnv === "true" ||
      port === 465;
    smtp = { host, port, user, pass, secure };
  }

  if (!mintOnly && via === "gmail_raw") {
    const accessToken = str(flags, "gmail-access-token", "GMAIL_ACCESS_TOKEN");
    if (!accessToken) {
      console.error("gmail_raw requires GMAIL_ACCESS_TOKEN (OAuth scope gmail.send). No OAuth UI in this CLI.");
      return 1;
    }
    gmail = { accessToken };
  }

  let inputText: string;
  try {
    inputText = await fs.readFile(csvPath, "utf8");
  } catch (err) {
    console.error(`failed to read --csv: ${errorText(err)}`);
    return 1;
  }

  let parsed: { headers: string[]; records: Record<string, string>[] };
  try {
    parsed = parseCsvRecords(inputText);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return 1;
  }

  const extra = [...RESULT_COLUMNS, ...(rawDir ? [RAW_PATH_COLUMN] : [])];
  const outHeaders = mergeHeaders(parsed.headers, extra);
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await fs.writeFile(outPath, stringifyCsv([outHeaders]), "utf8");

  const result = await runBatch({
    records: parsed.records,
    headers: parsed.headers,
    mintOnly,
    via: mintOnly ? "" : via,
    delayMs,
    defaultFrom,
    defaultMode,
    baseUrl,
    apiKey,
    smtp,
    gmail,
    deps: {
      sendSmtp: sendRawMimeSmtp,
      sendGmail: sendRawGmail,
      writeRaw: rawDir ? (messageId, rawMime) => writeRawToDir(rawDir, messageId, rawMime) : undefined,
    },
    onRow: async (combined, index) => {
      await fs.appendFile(outPath, stringifyCsv([outHeaders.map((h) => combined[h] ?? "")]), "utf8");
      const to = cell(combined, "to") || "?";
      console.error(
        `[${index + 1}/${parsed.records.length}] ${to} ${combined.status}${combined.error ? ` ${combined.error}` : ""}`,
      );
    },
  });

  await fs.writeFile(outPath, result.csv, "utf8");

  console.log(
    JSON.stringify(
      {
        total: result.summary.total,
        minted: result.summary.minted,
        sent: result.summary.sent,
        error: result.summary.error,
        out: outPath,
        mint_only: mintOnly,
        via: mintOnly ? undefined : via,
        delay_ms: delayMs,
      },
      null,
      2,
    ),
  );

  return result.summary.error > 0 ? 1 : 0;
}

const invokedDirectly =
  process.argv[1]?.replace(/\\/g, "/").split("/").pop() === "batch-cli.ts" ||
  process.argv[1]?.endsWith("/client/batch-cli") === true;
if (invokedDirectly) {
  main().then((code) => process.exit(code));
}
