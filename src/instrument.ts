import { shouldRewriteLink } from "./redirect";
import type { Mode } from "./types";

const TEXT_URL_RE = /https?:\/\/[^\s<>"'\\]+/gi;
const HREF_RE = /(\s(?:href)\s*=\s*)(["'])([^"']*)\2/gi;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripTrailingPunctuation(url: string): string {
  return url.replace(/[),.;:!?]+$/g, "");
}

export function extractTextUrls(text: string): string[] {
  const found: string[] = [];
  const re = new RegExp(TEXT_URL_RE.source, TEXT_URL_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const url = stripTrailingPunctuation(match[0]);
    if (shouldRewriteLink(url)) found.push(url);
  }
  return uniquePreserveOrder(found);
}

export function extractHtmlHrefUrls(html: string): string[] {
  const found: string[] = [];
  const re = new RegExp(HREF_RE.source, HREF_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const raw = match[3].replace(/&amp;/g, "&").trim();
    if (shouldRewriteLink(raw)) found.push(raw);
  }
  return uniquePreserveOrder(found);
}

function uniquePreserveOrder(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

export function replaceTextUrls(text: string, map: Map<string, string>): string {
  if (map.size === 0) return text;
  const originals = [...map.keys()].sort((a, b) => b.length - a.length);
  const placeholders: { token: string; value: string }[] = [];
  let out = text;
  originals.forEach((original, i) => {
    const tracked = map.get(original);
    if (!tracked) return;
    const token = `\u0000T${i}\u0000`;
    out = out.split(original).join(token);
    placeholders.push({ token, value: tracked });
  });
  for (const p of placeholders) out = out.split(p.token).join(p.value);
  return out;
}

export function rewriteHtmlHrefs(html: string, map: Map<string, string>): string {
  return html.replace(HREF_RE, (full, prefix: string, quote: string, raw: string) => {
    const url = raw.replace(/&amp;/g, "&").trim();
    if (!shouldRewriteLink(url)) return full;
    const tracked = map.get(url);
    if (!tracked) return full;
    return `${prefix}${quote}${escapeHtml(tracked)}${quote}`;
  });
}

export function proseToBareHtml(text: string, map: Map<string, string>): string {
  let escaped = escapeHtml(text);
  const originals = [...map.keys()].sort((a, b) => b.length - a.length);
  const placeholders: { token: string; html: string }[] = [];
  originals.forEach((original, i) => {
    const tracked = map.get(original);
    if (!tracked) return;
    const token = `\u0000H${i}\u0000`;
    escaped = escaped.split(escapeHtml(original)).join(token);
    placeholders.push({
      token,
      html: `<a href="${escapeHtml(tracked)}">${escapeHtml(original)}</a>`,
    });
  });
  for (const p of placeholders) escaped = escaped.split(p.token).join(p.html);
  const paragraphs = escaped
    .split(/\n{2,}/)
    .map((block) => `<p>${block.replace(/\n/g, "<br>\n")}</p>`);
  return paragraphs.join("\n");
}

export function pixelTag(pixelUrl: string): string {
  return `<img src="${escapeHtml(pixelUrl)}" width="1" height="1" alt="">`;
}

export function hasTrackingPixel(html: string): boolean {
  return /<img\b[^>]*\/o\/[A-Za-z0-9._-]+/i.test(html);
}

export function injectPixel(html: string, pixelUrl: string): string {
  if (hasTrackingPixel(html)) return html;
  const img = pixelTag(pixelUrl);
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${img}</body>`);
  }
  return `${html}${img}`;
}

export function clickUrl(baseUrl: string, token: string): string {
  return `${trimSlash(baseUrl)}/c/${token}`;
}

export function openUrl(baseUrl: string, token: string): string {
  return `${trimSlash(baseUrl)}/o/${token}`;
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function collectUrls(mode: Mode, text?: string, html?: string): string[] {
  if (mode === "html") {
    return extractHtmlHrefUrls(html ?? "");
  }
  return extractTextUrls(text ?? "");
}

export interface InstrumentInput {
  mode: Mode;
  text?: string;
  html?: string;
  linkMap: Map<string, string>;
  pixelUrl: string | null;
}

export interface InstrumentOutput {
  text: string | null;
  html: string | null;
  open_tracking: boolean;
}

/**
 * Three agent modes, no others:
 * - plain_looking (default): prose → text/plain + bare HTML twin + pixel
 * - plain_only: text + link rewrites; open tracking off
 * - html: instrument existing HTML
 */
export function instrument(input: InstrumentInput): InstrumentOutput {
  const { mode, text, html, linkMap, pixelUrl } = input;

  if (mode === "plain_only") {
    return {
      text: replaceTextUrls(text ?? "", linkMap),
      html: null,
      open_tracking: false,
    };
  }

  if (mode === "html") {
    let out = rewriteHtmlHrefs(html ?? "", linkMap);
    if (pixelUrl) out = injectPixel(out, pixelUrl);
    return {
      text: text ? replaceTextUrls(text, linkMap) : null,
      html: out,
      open_tracking: true,
    };
  }

  // plain_looking
  const source = text ?? "";
  const instrumentedText = replaceTextUrls(source, linkMap);
  let bare = proseToBareHtml(source, linkMap);
  if (pixelUrl) {
    bare = `${bare}\n${pixelTag(pixelUrl)}`;
  }
  return {
    text: instrumentedText,
    html: bare,
    open_tracking: true,
  };
}

export { isSafeRedirectUrl, shouldRewriteLink } from "./redirect";
