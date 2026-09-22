import { z } from "zod";

const modeSchema = z.enum(["plain_looking", "plain_only", "html"]).describe("AMT mode. Default plain_looking.");

/**
 * Passthrough keeps unknown keys so the handler can reject htmlBody / textBody.
 * Those names are intentionally absent from the advertised properties.
 */
function toolArgs<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).passthrough();
}

export const mintTrackedMessageSchema = toolArgs({
  to: z.string().describe("Recipient email."),
  from: z.string().optional().describe("RFC822 From. Include it when you will send via SMTP."),
  subject: z.string().optional(),
  text: z
    .string()
    .optional()
    .describe("Prose body. Required unless mode is html. This is not connector textBody."),
  html: z
    .string()
    .optional()
    .describe("Markup to instrument when mode is html. This is AMT content, not connector htmlBody, and must not be sent through a compose API."),
  mode: modeSchema.optional(),
  metadata: z.record(z.unknown()).optional().describe("JSON object stored on the message."),
  webhook_url: z.string().optional().describe("HTTPS URL for first open / first click."),
  tracking_base_url: z.string().optional().describe("Origin baked into pixel and click URLs."),
  include_raw: z
    .boolean()
    .optional()
    .describe("When true, include raw_mime and raw_base64url. Default false returns a short summary only."),
});

export const sendTrackedEmailSchema = toolArgs({
  to: z.string().describe("Recipient email."),
  from: z
    .string()
    .optional()
    .describe("RFC822 From. Required (falls back to AMT_FROM). Must match the SMTP mailbox or Gmail send-as."),
  via: z
    .enum(["smtp", "gmail_raw"])
    .optional()
    .describe("smtp sends raw_mime via SMTP DATA. gmail_raw sends raw_base64url to Gmail users.messages.send {raw}. Default follows which transport env is set."),
  subject: z.string().optional(),
  text: z.string().optional().describe("Prose body used when this call mints. Omit when passing raw_mime or raw_base64url."),
  html: z
    .string()
    .optional()
    .describe("Markup used when this call mints with mode=html. Not connector htmlBody."),
  mode: modeSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
  webhook_url: z.string().optional(),
  tracking_base_url: z.string().optional(),
  message_id: z
    .string()
    .optional()
    .describe("AMT message_id from mint_tracked_message, when sending an existing raw MIME without minting again."),
  raw_mime: z.string().optional().describe("Existing RFC822 from mint_tracked_message. Skips a second mint."),
  raw_base64url: z
    .string()
    .optional()
    .describe("Existing Gmail-ready raw from mint_tracked_message. Skips a second mint."),
  include_raw: z.boolean().optional().describe("When true, echo raw_mime and raw_base64url. Default false."),
});

export const getTrackedMessageSchema = toolArgs({
  message_id: z.string().describe("AMT message_id returned by mint_tracked_message or send_tracked_email."),
});

const batchRowSchema = z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]));

export const mintTrackedBatchSchema = toolArgs({
  csv: z
    .string()
    .optional()
    .describe("Mailmerge CSV text including the header row. Map email→to and body_text→text. Pass csv or rows."),
  rows: z.array(batchRowSchema).optional().describe("Mailmerge rows. Pass rows or csv."),
  from: z.string().optional().describe("RFC822 From for every row (or AMT_FROM). Required."),
  touch: z.enum(["E1", "E2", "E3"]).optional().describe("Optional wave touch stored in metadata."),
  campaign: z.string().optional().describe("Campaign slug stored in metadata."),
  delay_ms: z.number().int().optional().describe("Pause between mints. Default 1000. This tool does not send."),
  mode: modeSchema.optional(),
  include_csv: z.boolean().optional().describe("When true, include the log CSV. Default false returns row ids only."),
  webhook_url: z.string().optional(),
  tracking_base_url: z.string().optional(),
});
