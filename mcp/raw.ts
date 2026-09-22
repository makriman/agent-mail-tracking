/** UTF-8 base64url, matching the Worker `raw_base64url` encoding (no padding). */
export function utf8ToBase64Url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

export function utf8FromBase64Url(b64url: string): string {
  return Buffer.from(b64url, "base64url").toString("utf8");
}
