import { toBase64Url } from "./crypto";

export interface RawMimeInput {
  to: string;
  from?: string | null;
  subject?: string | null;
  text?: string | null;
  html?: string | null;
  messageId: string;
  /** ISO-8601 timestamp used for the Date header. */
  date: string;
  baseUrl: string;
}

export interface RawMimeOutput {
  /** RFC 5322 message with CRLF line endings. Ready for SMTP DATA. */
  raw_mime: string;
  /** Gmail API `users.messages.send` / `users.drafts.create` `{ raw }` value. */
  raw_base64url: string;
}

/**
 * Build a ready-to-send RFC 5322 payload that preserves the tracking pixel.
 *
 * - `plain_looking` / `html` with both bodies → `multipart/alternative`
 *   (text/plain + text/html). The HTML part includes the 1×1 `/o/` `<img>`.
 * - text only (`plain_only`) → `text/plain` (no open pixel).
 * - html only → `text/html`.
 *
 * `From` is omitted when not provided so Gmail can fill the authenticated user.
 */
export function buildRawMime(input: RawMimeInput): RawMimeOutput {
  const text = emptyToNull(input.text);
  const html = emptyToNull(input.html);
  if (!text && !html) {
    throw new Error("mime_body_required");
  }

  const host = hostnameFromBase(input.baseUrl);
  const boundary = makeBoundary();
  const headers: string[] = [
    `MIME-Version: 1.0`,
    `Date: ${rfc5322Date(input.date)}`,
    `Message-ID: <${sanitizeToken(input.messageId)}@${host}>`,
    `To: ${headerEmail(input.to)}`,
  ];
  if (input.from) headers.push(`From: ${headerEmail(input.from)}`);
  headers.push(`Subject: ${encodeUnstructuredHeader(input.subject ?? "")}`);

  let body: string;
  if (text && html) {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = [
      `This is a multi-part message in MIME format.`,
      ``,
      `--${boundary}`,
      `Content-Type: text/plain; charset=utf-8`,
      `Content-Transfer-Encoding: quoted-printable`,
      ``,
      encodeQuotedPrintable(text),
      `--${boundary}`,
      `Content-Type: text/html; charset=utf-8`,
      `Content-Transfer-Encoding: quoted-printable`,
      ``,
      encodeQuotedPrintable(html),
      `--${boundary}--`,
      ``,
    ].join("\r\n");
  } else if (html) {
    headers.push(`Content-Type: text/html; charset=utf-8`);
    headers.push(`Content-Transfer-Encoding: quoted-printable`);
    body = encodeQuotedPrintable(html);
  } else {
    headers.push(`Content-Type: text/plain; charset=utf-8`);
    headers.push(`Content-Transfer-Encoding: quoted-printable`);
    body = encodeQuotedPrintable(text as string);
  }

  const raw_mime = `${headers.join("\r\n")}\r\n\r\n${body}`.replace(/\r?\n/g, "\r\n");
  return { raw_mime, raw_base64url: utf8ToBase64Url(raw_mime) };
}

export function utf8ToBase64Url(text: string): string {
  return toBase64Url(new TextEncoder().encode(text));
}

export function utf8FromBase64Url(b64url: string): string {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function encodeQuotedPrintable(input: string): string {
  const normalized = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const bytes = new TextEncoder().encode(normalized);
  const lines: string[] = [];
  let line = "";

  const flushHard = () => {
    lines.push(encodeTrailingWs(line));
    line = "";
  };

  const append = (token: string) => {
    // RFC 2045: encoded lines ≤ 76; soft-break with a trailing "=".
    if (line.length + token.length > 75) {
      lines.push(`${line}=`);
      line = "";
    }
    line += token;
  };

  for (const b of bytes) {
    if (b === 10) {
      flushHard();
      continue;
    }
    if (b === 13) continue;
    if ((b >= 33 && b <= 60) || (b >= 62 && b <= 126)) {
      append(String.fromCharCode(b));
    } else if (b === 9 || b === 32) {
      append(String.fromCharCode(b));
    } else {
      append(`=${b.toString(16).toUpperCase().padStart(2, "0")}`);
    }
  }
  if (line) flushHard();
  return lines.join("\r\n");
}

export function decodeQuotedPrintable(input: string): string {
  const unfolded = input.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < unfolded.length; i++) {
    const ch = unfolded[i];
    if (ch === "=" && i + 2 < unfolded.length) {
      const hex = unfolded.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    if (ch === "\r") continue;
    if (ch === "\n") {
      bytes.push(10);
      continue;
    }
    bytes.push(unfolded.charCodeAt(i));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Split a built message into headers + decoded body parts (tests / agents). */
export function parseMime(raw: string): {
  headers: Record<string, string>;
  text: string | null;
  html: string | null;
} {
  const normalized = raw.replace(/\r\n/g, "\n");
  const split = normalized.indexOf("\n\n");
  const headerBlock = split === -1 ? normalized : normalized.slice(0, split);
  const body = split === -1 ? "" : normalized.slice(split + 2);
  const headers = parseHeaders(headerBlock);
  const ct = headers["content-type"] ?? "";
  const boundary = ct.match(/boundary="?([^";]+)"?/i)?.[1];

  if (boundary && /multipart\//i.test(ct)) {
    const parts = splitMultipart(body, boundary);
    let text: string | null = null;
    let html: string | null = null;
    for (const part of parts) {
      const partCt = part.headers["content-type"] ?? "";
      const decoded = decodePart(part.body, part.headers["content-transfer-encoding"]);
      if (/text\/html/i.test(partCt)) html = decoded;
      else if (/text\/plain/i.test(partCt)) text = decoded;
    }
    return { headers, text, html };
  }

  const decoded = decodePart(body.replace(/\n/g, "\r\n"), headers["content-transfer-encoding"]);
  if (/text\/html/i.test(ct)) return { headers, text: null, html: decoded };
  return { headers, text: decoded, html: null };
}

function decodePart(body: string, encoding: string | undefined): string {
  const enc = (encoding ?? "").toLowerCase();
  if (enc === "quoted-printable") return decodeQuotedPrintable(body);
  if (enc === "base64") {
    const compact = body.replace(/\s+/g, "");
    const bin = atob(compact);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  return body.replace(/\r\n/g, "\n");
}

function parseHeaders(block: string): Record<string, string> {
  const unfolded = block.replace(/\n[ \t]+/g, " ");
  const headers: Record<string, string> = {};
  for (const line of unfolded.split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    headers[name] = line.slice(idx + 1).trim();
  }
  return headers;
}

function splitMultipart(body: string, boundary: string): { headers: Record<string, string>; body: string }[] {
  const delim = `--${boundary}`;
  const chunks = body.split(delim).slice(1);
  const parts: { headers: Record<string, string>; body: string }[] = [];
  for (const chunk of chunks) {
    if (chunk.startsWith("--")) break;
    const raw = chunk.replace(/^\n/, "").replace(/\n$/g, "");
    const split = raw.indexOf("\n\n");
    const headerBlock = split === -1 ? raw : raw.slice(0, split);
    const partBody = split === -1 ? "" : raw.slice(split + 2).replace(/\n$/g, "");
    parts.push({ headers: parseHeaders(headerBlock), body: partBody.replace(/\n/g, "\r\n") });
  }
  return parts;
}

function encodeTrailingWs(line: string): string {
  if (line.endsWith(" ") || line.endsWith("\t")) {
    const last = line.charCodeAt(line.length - 1);
    return `${line.slice(0, -1)}=${last.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return line;
}

function encodeUnstructuredHeader(value: string): string {
  const sanitized = singleLine(value);
  if (sanitized === "") return "";
  if (/^[\x20-\x7E]*$/.test(sanitized)) return sanitized;
  let bin = "";
  for (const b of new TextEncoder().encode(sanitized)) bin += String.fromCharCode(b);
  return `=?UTF-8?B?${btoa(bin)}?=`;
}

function headerEmail(value: string): string {
  return singleLine(value);
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function sanitizeToken(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "");
}

function hostnameFromBase(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname;
    return host || "localhost";
  } catch {
    return "localhost";
  }
}

function rfc5322Date(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return new Date().toUTCString().replace(/GMT$/i, "+0000");
  return d.toUTCString().replace(/GMT$/i, "+0000");
}

function makeBoundary(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `----=_Amt_${hex}`;
}

function emptyToNull(value?: string | null): string | null {
  if (value == null) return null;
  return value.length ? value : null;
}
