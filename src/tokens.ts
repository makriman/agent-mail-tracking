import { hmacSha256, safeEqual, toBase64Url } from "./crypto";

export type TokenKind = "o" | "c";

function payloadFor(kind: TokenKind, id: string): string {
  return `${kind}:${id}`;
}

export async function signToken(kind: TokenKind, id: string, secret: string): Promise<string> {
  const sig = await hmacSha256(secret, payloadFor(kind, id));
  return `${id}.${toBase64Url(sig.subarray(0, 16))}`;
}

/** msg_/lnk_ id + dot + 16-byte truncated HMAC is well under this. */
const MAX_TOKEN_LENGTH = 512;

export async function verifyToken(
  kind: TokenKind,
  token: string,
  secret: string,
): Promise<string | null> {
  if (!token || token.length > MAX_TOKEN_LENGTH) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const id = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!id || !sig) return null;
  const expected = await signToken(kind, id, secret);
  return safeEqual(expected, token) ? id : null;
}

export async function hashIp(ip: string | null | undefined, secret: string): Promise<string | null> {
  if (!ip) return null;
  const digest = await hmacSha256(secret, `ip:${ip}`);
  return toBase64Url(digest);
}
