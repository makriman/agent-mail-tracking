/** 1×1 transparent GIF. Classic email beacon; clients that block images never fire. */
const GIF_B64 = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

export function pixelGifBytes(): Uint8Array {
  const bin = atob(GIF_B64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Shared no-store set. `private` + `no-store` bypasses Workers Cache (RFC 9111). */
export const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, private, max-age=0",
  "CDN-Cache-Control": "no-store",
  Pragma: "no-cache",
  Expires: "0",
} as const;

export const PIXEL_HEADERS = {
  "Content-Type": "image/gif",
  ...NO_STORE_HEADERS,
} as const;
