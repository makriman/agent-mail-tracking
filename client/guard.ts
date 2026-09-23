import { AmtClientError } from "./types";

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

function utf8FromBase64Url(b64url: string): string {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** True when quoted-printable soft breaks still leave a literal open-pixel `<img>`. */
export function mimeHasOpenPixel(rawMime: string): boolean {
  const unfolded = rawMime.replace(/=\r?\n/g, "");
  return /<img\b[^>]*\/o\//i.test(unfolded);
}

/**
 * SMTP sends `raw_mime` and Gmail sends `raw_base64url`. They must be the same bytes.
 * Open-tracked modes must still contain the `<img>` after that decode. `plain_only` has no pixel.
 */
export function assertSendableRawMime(minted: {
  mode?: string;
  raw_mime?: string | null;
  raw_base64url?: string | null;
}): void {
  if (!minted.raw_mime || !minted.raw_base64url) {
    throw new AmtClientError("mint response missing raw_mime / raw_base64url");
  }
  let decoded: string;
  try {
    decoded = utf8FromBase64Url(minted.raw_base64url);
  } catch {
    throw new AmtClientError("mint response raw_base64url is not valid base64url");
  }
  if (decoded !== minted.raw_mime) {
    throw new AmtClientError("mint response raw_base64url does not match raw_mime. Refusing to send.");
  }
  if (minted.mode !== "plain_only" && !mimeHasOpenPixel(decoded)) {
    throw new AmtClientError(
      "mint response raw_mime is missing the open-tracking <img>. Refusing to send. Do not fall back to htmlBody.",
    );
  }
}

export class AmtHtmlBodyError extends Error {
  constructor(message = HTML_BODY_BANNED) {
    super(message);
    this.name = "AmtHtmlBodyError";
  }
}
