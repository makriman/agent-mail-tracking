import type { MintedMessage } from "../client/types";

export interface RawMimeSummary {
  mime_bytes: number;
  base64url_bytes: number;
  has_open_pixel: boolean;
}

export interface MintToolSummary {
  message_id: string;
  pixel_url: string | null;
  open_tracking: boolean;
  opens: number | null;
  clicks: number;
  status: string;
  to: string;
  from: string | null;
  subject: string | null;
  mode: string;
  base_url: string;
  raw: RawMimeSummary;
  raw_mime?: string;
  raw_base64url?: string;
}

export function rawMimeSummary(rawMime: string, rawBase64url: string): RawMimeSummary {
  return {
    mime_bytes: rawMime.length,
    base64url_bytes: rawBase64url.length,
    has_open_pixel: rawMime.includes("<img") && rawMime.includes("/o/"),
  };
}

/** message_id, pixel_url, and a short MIME summary. Full raw only when includeRaw is set. */
export function summarizeMinted(minted: MintedMessage, includeRaw: boolean): MintToolSummary {
  const summary: MintToolSummary = {
    message_id: minted.message_id,
    pixel_url: minted.pixel_url,
    open_tracking: minted.open_tracking,
    opens: minted.opens,
    clicks: minted.clicks,
    status: minted.status,
    to: minted.to,
    from: minted.from,
    subject: minted.subject,
    mode: minted.mode,
    base_url: minted.base_url,
    raw: rawMimeSummary(minted.raw_mime, minted.raw_base64url),
  };
  if (includeRaw) {
    summary.raw_mime = minted.raw_mime;
    summary.raw_base64url = minted.raw_base64url;
  }
  return summary;
}
