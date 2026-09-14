/** Connector compose fields that strip `<img>` and kill open tracking. */
export const HTML_BODY_BANNED =
  "htmlBody is banned. Gmail/Outlook connector htmlBody (and textBody / JSON HTML body) strip <img> pixels so opens never fire. Mint with this client, then send raw_mime via SMTP or raw_base64url via Gmail users.messages.send (scope gmail.send). Never htmlBody.";

export function assertNoHtmlBody(input: unknown): void {
  if (!input || typeof input !== "object") return;
  const rec = input as Record<string, unknown>;
  if (rec.htmlBody != null || rec.textBody != null) {
    throw new AmtHtmlBodyError(HTML_BODY_BANNED);
  }
}

export class AmtHtmlBodyError extends Error {
  constructor(message = HTML_BODY_BANNED) {
    super(message);
    this.name = "AmtHtmlBodyError";
  }
}
