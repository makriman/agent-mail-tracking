#!/usr/bin/env node
/**
 * Mint a tracked message then send raw MIME.
 *
 *   npm run send-tracked -- --to ada@example.com --from you@icloud.com --subject Hello --text "Hi"
 *
 * Env (never commit secrets):
 *   AMT_API_KEY  AMT_BASE_URL  AMT_FROM
 *   SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS SMTP_SECURE
 *   GMAIL_ACCESS_TOKEN   (gmail.send scope; no OAuth UI here)
 *
 * htmlBody is banned. This CLI never calls connector compose helpers.
 */
import { sendTrackedEmail } from "./send";
import { HTML_BODY_BANNED } from "./guard";
import { AmtClientError } from "./types";
import type { Mode, SendVia } from "./types";

const USAGE = `Usage: npm run send-tracked -- --to <email> [options]

Mint via POST /v1/messages, then send raw MIME (SMTP DATA or Gmail API raw).
Never uses htmlBody (Gmail/Outlook connectors strip the open pixel).

Required:
  --to <email>

Content:
  --subject <text>
  --text <prose>          (required unless --html / mode=html)
  --html <markup>
  --mode plain_looking|plain_only|html   (default plain_looking)
  --from <email>          always forwarded to mint when set (SMTP requires it)

Transport:
  --via smtp|gmail_raw    default: gmail_raw if GMAIL_ACCESS_TOKEN else smtp

Env:
  AMT_BASE_URL            default https://track.greatindiancompany.com
  AMT_API_KEY             Worker API_KEY (Bearer)
  AMT_FROM                fallback for --from
  SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS SMTP_SECURE
  GMAIL_ACCESS_TOKEN      users.messages.send; scope gmail.send
  SMTP_HOST               e.g. smtp.mail.me.com (iCloud, port 587 STARTTLS)

Do not put mailbox passwords or OAuth tokens in git or Worker secrets.
`;

interface Flags {
  [key: string]: string | boolean | undefined;
}

export function parseArgs(argv: string[]): Flags {
  const out: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") {
      out.help = true;
      continue;
    }
    if (!a.startsWith("--")) {
      throw new AmtClientError(`unexpected argument: ${a}`);
    }
    const eq = a.indexOf("=");
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next != null && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function str(flags: Flags, key: string, envName?: string): string | undefined {
  const v = flags[key];
  if (typeof v === "string" && v.length > 0) return v;
  if (envName) {
    const env = process.env[envName];
    if (env) return env;
  }
  return undefined;
}

function printResult(result: Awaited<ReturnType<typeof sendTrackedEmail>>) {
  const out = {
    message_id: result.minted.message_id,
    via: result.via,
    to: result.minted.to,
    from: result.minted.from,
    pixel_url: result.minted.pixel_url,
    open_tracking: result.minted.open_tracking,
    smtp: result.smtp ? { accepted: result.smtp.accepted, response: result.smtp.response } : undefined,
    gmail: result.gmail,
  };
  console.log(JSON.stringify(out, null, 2));
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
    console.log(USAGE);
    return 0;
  }

  if (flags.htmlBody != null || flags["html-body"] != null || flags.textBody != null) {
    console.error(HTML_BODY_BANNED);
    return 1;
  }

  const to = str(flags, "to");
  const from =
    str(flags, "from", "AMT_FROM") ??
    (process.env.SMTP_USER?.includes("@") ? process.env.SMTP_USER : undefined);
  const subject = str(flags, "subject");
  const text = str(flags, "text");
  const html = str(flags, "html");
  const mode = str(flags, "mode") as Mode | undefined;
  const apiKey = str(flags, "api-key", "AMT_API_KEY");
  const baseUrl = str(flags, "base-url", "AMT_BASE_URL") ?? "https://track.greatindiancompany.com";

  let via = str(flags, "via") as SendVia | undefined;
  if (!via) {
    via = process.env.GMAIL_ACCESS_TOKEN && !process.env.SMTP_HOST ? "gmail_raw" : "smtp";
  }

  if (!to) {
    console.error("missing --to\n");
    console.error(USAGE);
    return 1;
  }
  if (!apiKey) {
    console.error("missing AMT_API_KEY (or --api-key)");
    return 1;
  }
  if (mode && mode !== "plain_looking" && mode !== "plain_only" && mode !== "html") {
    console.error("invalid --mode (plain_looking | plain_only | html)");
    return 1;
  }
  if (mode === "html" ? !html : !text) {
    console.error(mode === "html" ? "missing --html for mode=html" : "missing --text");
    return 1;
  }
  if (via !== "smtp" && via !== "gmail_raw") {
    console.error("invalid --via (smtp | gmail_raw)");
    return 1;
  }

  try {
    if (via === "smtp") {
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
      if (!from) {
        console.error("SMTP requires --from or AMT_FROM (and mint From must match the mailbox)");
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
      const result = await sendTrackedEmail({
        baseUrl,
        apiKey,
        to,
        from,
        subject,
        text,
        html,
        mode,
        via: "smtp",
        smtp: {
          host,
          port,
          user,
          pass,
          secure,
        },
      });
      printResult(result);
      return 0;
    }

    const accessToken = str(flags, "gmail-access-token", "GMAIL_ACCESS_TOKEN");
    if (!accessToken) {
      console.error("gmail_raw requires GMAIL_ACCESS_TOKEN (OAuth scope gmail.send). No OAuth UI in this CLI.");
      return 1;
    }
    const result = await sendTrackedEmail({
      baseUrl,
      apiKey,
      to,
      from,
      subject,
      text,
      html,
      mode,
      via: "gmail_raw",
      gmail: { accessToken },
    });
    printResult(result);
    return 0;
  } catch (err) {
    if (err instanceof AmtClientError) {
      console.error(err.message);
      if (err.body != null) console.error(JSON.stringify(err.body));
      return 1;
    }
    console.error(err instanceof Error ? err.message : err);
    return 1;
  }
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").split("/").pop() === "cli.ts" || process.argv[1]?.endsWith("/client/cli") === true;
if (invokedDirectly) {
  main().then((code) => process.exit(code));
}
