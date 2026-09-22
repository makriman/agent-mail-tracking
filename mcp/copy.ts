/**
 * Wording agents see in tool descriptions and server instructions.
 * The README must contain OPEN_TRACKING_INSTRUCTION verbatim.
 */
export const OPEN_TRACKING_INSTRUCTION =
  "For open tracking, call AMT MCP send_tracked_email — do not use Gmail MCP send_message";

/** Appended to every tool description. Names the banned connector fields without offering them as inputs. */
export const CONNECTOR_BAN =
  "htmlBody and textBody are banned: Gmail/Outlook connector compose strips <img> pixels and opens stay no_signal. " +
  OPEN_TRACKING_INSTRUCTION +
  ".";

export const SERVER_INSTRUCTIONS =
  OPEN_TRACKING_INSTRUCTION +
  ". AMT mints RFC822 that still contains the 1x1 open pixel. This MCP sends that MIME with SMTP DATA (raw_mime) or Gmail API users.messages.send {raw: raw_base64url}. " +
  CONNECTOR_BAN +
  " Transport secrets (AMT_API_KEY, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, GMAIL_ACCESS_TOKEN) come from the MCP process environment, never from tool arguments. The tracking Worker does not send mail.";
