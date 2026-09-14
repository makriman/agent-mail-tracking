import { assertNoHtmlBody } from "./guard";
import { AmtClientError, type MintedMessage, type MintTrackedMessageOptions } from "./types";

export function trimBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

export interface ShapedMintRequest {
  url: string;
  headers: { Authorization: string; "Content-Type": "application/json" };
  body: Record<string, unknown>;
}

/**
 * Shape POST /v1/messages. Always includes `from` when the caller provided it.
 * Never emits htmlBody / textBody.
 */
export function shapeMintRequest(opts: MintTrackedMessageOptions): ShapedMintRequest {
  assertNoHtmlBody(opts);
  if (!opts.baseUrl?.trim()) throw new AmtClientError("baseUrl is required");
  if (!opts.apiKey) throw new AmtClientError("apiKey is required");
  if (!opts.to?.includes("@")) throw new AmtClientError("to must be an email address");

  const body: Record<string, unknown> = { to: opts.to };
  if (opts.from != null && opts.from !== "") body.from = opts.from;
  if (opts.subject != null) body.subject = opts.subject;
  if (opts.text != null) body.text = opts.text;
  if (opts.html != null) body.html = opts.html;
  if (opts.mode) body.mode = opts.mode;
  if (opts.metadata) body.metadata = opts.metadata;
  if (opts.webhookUrl) body.webhook_url = opts.webhookUrl;
  if (opts.trackingBaseUrl) body.base_url = opts.trackingBaseUrl;

  return {
    url: `${trimBaseUrl(opts.baseUrl)}/v1/messages`,
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body,
  };
}

export async function mintTrackedMessage(opts: MintTrackedMessageOptions): Promise<MintedMessage> {
  const req = shapeMintRequest(opts);
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
    throw new AmtClientError(`mint failed: invalid JSON (${res.status})`, { status: res.status, body: raw });
  }

  if (!res.ok) {
    const errMsg =
      parsed && typeof parsed === "object" && parsed !== null && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : raw || res.statusText;
    throw new AmtClientError(`mint failed: ${res.status} ${errMsg}`, { status: res.status, body: parsed });
  }

  const minted = parsed as MintedMessage;
  if (!minted?.raw_mime || !minted.raw_base64url) {
    throw new AmtClientError("mint failed: response missing raw_mime / raw_base64url", {
      status: res.status,
      body: parsed,
    });
  }
  return minted;
}
