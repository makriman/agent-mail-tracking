import { describe, expect, it } from "vitest";
import { instrument, pixelTag, trackingOrigin } from "../src/instrument";
import {
  buildRawMime,
  decodeQuotedPrintable,
  encodeQuotedPrintable,
  parseMime,
  utf8FromBase64Url,
} from "../src/mime";

const pixelUrl = "https://track.greatindiancompany.com/o/msg_abc.sig";
const linkMap = new Map<string, string>([
  ["https://example.com/docs", "https://track.greatindiancompany.com/c/lnk_docs.sig"],
]);

function mimeFromInstrument(mode: "plain_looking" | "plain_only" | "html", text?: string, html?: string) {
  const result = instrument({
    mode,
    text,
    html,
    linkMap,
    pixelUrl: mode === "plain_only" ? null : pixelUrl,
  });
  return {
    result,
    mime: buildRawMime({
      to: "ada@example.com",
      from: "agent@example.com",
      subject: "Hello",
      text: result.text,
      html: result.html,
      messageId: "msg_abc",
      date: "2026-09-12T01:08:00.000Z",
      baseUrl: "https://track.greatindiancompany.com",
    }),
  };
}

describe("buildRawMime", () => {
  it("plain_looking multipart HTML part contains the /o/ pixel and round-trips", () => {
    const { result, mime } = mimeFromInstrument(
      "plain_looking",
      "Hi Ada,\n\nSee https://example.com/docs and write back.",
    );
    expect(result.open_tracking).toBe(true);
    expect(result.html).toContain(pixelTag(pixelUrl));
    expect(mime.raw_mime).toMatch(/\r\n/);
    expect(mime.raw_mime).toMatch(/Content-Type: multipart\/alternative/i);
    expect(utf8FromBase64Url(mime.raw_base64url)).toBe(mime.raw_mime);

    const parsed = parseMime(mime.raw_mime);
    expect(parsed.headers.to).toBe("ada@example.com");
    expect(parsed.headers.from).toBe("agent@example.com");
    expect(parsed.headers.subject).toBe("Hello");
    expect(parsed.text).toContain("https://track.greatindiancompany.com/c/lnk_docs.sig");
    expect(parsed.html).toBe(result.html);
    expect(parsed.html).toContain('src="https://track.greatindiancompany.com/o/msg_abc.sig"');
    expect(parsed.html).toMatch(/<img\b[^>]*\/o\/msg_abc\.sig/i);
    expect(parsed.html).toContain('<a href="https://track.greatindiancompany.com/c/lnk_docs.sig">');
  });

  it("html mode single-part still embeds the /o/ pixel after parse", () => {
    const { result, mime } = mimeFromInstrument(
      "html",
      undefined,
      `<html><body><p>Hi <a href="https://example.com/docs">docs</a></p></body></html>`,
    );
    expect(mime.raw_mime).toMatch(/Content-Type: text\/html; charset=utf-8/i);
    expect(mime.raw_mime).not.toMatch(/multipart\/alternative/i);
    const parsed = parseMime(utf8FromBase64Url(mime.raw_base64url));
    expect(parsed.html).toBe(result.html);
    expect(parsed.html).toContain('src="https://track.greatindiancompany.com/o/msg_abc.sig"');
    expect(parsed.text).toBeNull();
  });

  it("plain_only is text/plain only and never includes an open pixel", () => {
    const { result, mime } = mimeFromInstrument("plain_only", "Plain https://example.com/docs");
    expect(result.open_tracking).toBe(false);
    expect(result.html).toBeNull();
    expect(mime.raw_mime).toMatch(/Content-Type: text\/plain; charset=utf-8/i);
    expect(mime.raw_mime).not.toMatch(/\/o\//);
    expect(mime.raw_mime).not.toMatch(/<img/i);
    const parsed = parseMime(mime.raw_mime);
    expect(parsed.html).toBeNull();
    expect(parsed.text).toContain("https://track.greatindiancompany.com/c/lnk_docs.sig");
  });

  it("omits From when not provided and strips header injection", () => {
    const mime = buildRawMime({
      to: "ada@example.com\nBcc: eve@evil.example",
      subject: "Hi\r\nX-Inject: yes",
      text: "Hello",
      html: `<p>Hello</p>\n${pixelTag(pixelUrl)}`,
      messageId: "msg_abc",
      date: "2026-09-12T01:08:00.000Z",
      baseUrl: "https://track.greatindiancompany.com",
    });
    expect(mime.raw_mime).not.toMatch(/^From:/m);
    const parsed = parseMime(mime.raw_mime);
    expect(parsed.headers.bcc).toBeUndefined();
    expect(parsed.headers["x-inject"]).toBeUndefined();
    expect(parsed.headers.to).toBe("ada@example.com Bcc: eve@evil.example");
    expect(parsed.headers.subject).toBe("Hi X-Inject: yes");
  });

  it("encodes non-ASCII subjects with RFC 2047", () => {
    const mime = buildRawMime({
      to: "ada@example.com",
      subject: "Café",
      text: "Hi",
      html: `<p>Hi</p>\n${pixelTag(pixelUrl)}`,
      messageId: "msg_abc",
      date: "2026-09-12T01:08:00.000Z",
      baseUrl: "https://track.greatindiancompany.com",
    });
    expect(mime.raw_mime).toMatch(/Subject: =\?UTF-8\?B\?/);
  });
});

describe("quoted-printable", () => {
  it("round-trips UTF-8, equals signs, and long lines", () => {
    const src = `Café = ${"https://track.example/o/"}${"a".repeat(80)}\n<img src="${pixelUrl}" width="1" height="1" alt="">`;
    const encoded = encodeQuotedPrintable(src);
    expect(encoded).toContain("=3D");
    expect(encoded.split("\r\n").every((line) => line.length <= 76)).toBe(true);
    expect(decodeQuotedPrintable(encoded)).toBe(src);
  });
});

describe("trackingOrigin", () => {
  it("keeps the persisted base_url instead of the request Host", () => {
    expect(
      trackingOrigin("https://track.greatindiancompany.com", "https://agent-mail-track.example.workers.dev"),
    ).toBe("https://track.greatindiancompany.com");
    expect(trackingOrigin(null, "https://agent-mail-track.example.workers.dev")).toBe(
      "https://agent-mail-track.example.workers.dev",
    );
  });
});
