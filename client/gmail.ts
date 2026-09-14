import { AmtClientError, type GmailAuth, type GmailSendResult } from "./types";

/** Required OAuth scope for `users.messages.send`. This client does not run an OAuth UI. */
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

export const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages.send";

export function gmailSendUrl(userId = "me"): string {
  return `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(userId)}/messages.send`;
}

export async function resolveGmailAccessToken(auth: GmailAuth): Promise<string> {
  if ("accessToken" in auth && auth.accessToken) return auth.accessToken;
  if ("googleauth" in auth && auth.googleauth) {
    const result = await auth.googleauth.getAccessToken();
    if (typeof result === "string" && result) return result;
    if (result && typeof result === "object" && result.token) return result.token;
  }
  throw new AmtClientError(
    `gmail access token required (OAuth scope ${GMAIL_SEND_SCOPE}). Pass accessToken or googleauth.getAccessToken().`,
  );
}

export function shapeGmailRawSend(rawBase64url: string, accessToken: string, userId = "me") {
  if (!rawBase64url) throw new AmtClientError("rawBase64url is required");
  return {
    url: gmailSendUrl(userId),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: { raw: rawBase64url },
  };
}

/**
 * Gmail API `users.messages.send` with `{ raw }`.
 * Requires scope `https://www.googleapis.com/auth/gmail.send`.
 * Do not use MCP/connector htmlBody — it strips the tracking pixel.
 */
export async function sendRawGmail(auth: GmailAuth, rawBase64url: string, userId = "me"): Promise<GmailSendResult> {
  const accessToken = await resolveGmailAccessToken(auth);
  const req = shapeGmailRawSend(rawBase64url, accessToken, userId);
  const res = await fetch(req.url, {
    method: "POST",
    headers: req.headers,
    body: JSON.stringify(req.body),
  });
  const raw = await res.text();
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    throw new AmtClientError(`gmail send failed: invalid JSON (${res.status})`, { status: res.status, body: raw });
  }
  if (!res.ok) {
    throw new AmtClientError(`gmail send failed: ${res.status} ${raw}`, { status: res.status, body: parsed });
  }
  return (parsed ?? {}) as GmailSendResult;
}
