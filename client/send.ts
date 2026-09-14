import { sendRawGmail } from "./gmail";
import { assertNoHtmlBody } from "./guard";
import { mintTrackedMessage } from "./mint";
import { sendRawMimeSmtp } from "./smtp";
import {
  AmtClientError,
  type GmailAuth,
  type GmailSendResult,
  type MintedMessage,
  type MintTrackedMessageOptions,
  type SendVia,
  type SmtpSendResult,
} from "./types";

export interface SmtpTransport {
  host: string;
  port: number;
  user: string;
  pass: string;
  secure?: boolean;
  timeoutMs?: number;
  ehloName?: string;
}

export interface SendTrackedEmailOptions extends MintTrackedMessageOptions {
  via: SendVia;
  smtp?: SmtpTransport;
  gmail?: GmailAuth;
  /** Banned. Presence throws — connectors strip `<img>`. */
  htmlBody?: never;
  textBody?: never;
}

export interface SendTrackedEmailResult {
  minted: MintedMessage;
  via: SendVia;
  smtp?: SmtpSendResult;
  gmail?: GmailSendResult;
}

/**
 * Mint instrumented MIME, then send via SMTP DATA or Gmail API raw.
 * Never uses htmlBody. Always forwards `from` to POST /v1/messages when provided.
 */
export async function sendTrackedEmail(opts: SendTrackedEmailOptions): Promise<SendTrackedEmailResult> {
  assertNoHtmlBody(opts);
  if (opts.via !== "smtp" && opts.via !== "gmail_raw") {
    throw new AmtClientError(`invalid_via: expected smtp | gmail_raw, got ${String(opts.via)}`);
  }

  const minted = await mintTrackedMessage({
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    to: opts.to,
    from: opts.from,
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
    mode: opts.mode,
    metadata: opts.metadata,
    webhookUrl: opts.webhookUrl,
    trackingBaseUrl: opts.trackingBaseUrl,
  });

  if (opts.via === "smtp") {
    if (!opts.smtp) throw new AmtClientError("smtp config required (host, port, user, pass)");
    const from = opts.from || minted.from;
    if (!from) throw new AmtClientError("from is required for SMTP MAIL FROM (pass from when minting)");
    const smtp = await sendRawMimeSmtp({
      host: opts.smtp.host,
      port: opts.smtp.port,
      user: opts.smtp.user,
      pass: opts.smtp.pass,
      secure: opts.smtp.secure,
      timeoutMs: opts.smtp.timeoutMs,
      ehloName: opts.smtp.ehloName,
      from,
      to: opts.to,
      rawMime: minted.raw_mime,
    });
    return { minted, via: "smtp", smtp };
  }

  if (!opts.gmail) {
    throw new AmtClientError("gmail auth required (accessToken or googleauth with gmail.send scope)");
  }
  const gmail = await sendRawGmail(opts.gmail, minted.raw_base64url);
  return { minted, via: "gmail_raw", gmail };
}
