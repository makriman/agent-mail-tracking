/**
 * Reference Node client for Agent Mail Track.
 *
 * AMT mints tracked MIME; this package sends it. The Worker still does not send mail.
 * Banned: Gmail/Outlook `htmlBody` / `textBody` (strips the open-tracking `<img>`).
 */
export { HTML_BODY_BANNED, AmtHtmlBodyError, assertNoHtmlBody } from "./guard";
export { mintTrackedMessage, shapeMintRequest, trimBaseUrl } from "./mint";
export { sendRawMimeSmtp, envelopeAddress, smtpDataPayload } from "./smtp";
export {
  sendRawGmail,
  resolveGmailAccessToken,
  shapeGmailRawSend,
  GMAIL_SEND_SCOPE,
  GMAIL_SEND_URL,
  gmailSendUrl,
} from "./gmail";
export { sendTrackedEmail } from "./send";
export type { SendTrackedEmailOptions, SendTrackedEmailResult, SmtpTransport } from "./send";
export {
  runBatch,
  parseCsv,
  parseCsvRecords,
  stringifyCsv,
  stringifyCsvRecords,
  csvEscape,
  parseDelayMs,
  parseTouch,
  parseCampaign,
  mergeHeaders,
  resolveRecipient,
  resolveBodyText,
  RESULT_COLUMNS,
  LOG_COLUMNS,
  RAW_PATH_COLUMN,
  PIXEL_URL_COLUMN,
  MAILMERGE_COLUMNS,
  DEFAULT_CAMPAIGN,
  TOUCHES,
  BATCH_USAGE,
} from "./batch";
export type { RunBatchOptions, BatchRunResult, BatchSummary, BatchStatus, BatchRunnerDeps, BatchSmtpConfig, Touch } from "./batch";
export type {
  Mode,
  SendVia,
  MintTrackedMessageOptions,
  MintedMessage,
  MintedLink,
  SmtpSendOptions,
  SmtpSendResult,
  GmailAuth,
  GoogleAuthLike,
  GmailSendResult,
} from "./types";
export { AmtClientError } from "./types";
