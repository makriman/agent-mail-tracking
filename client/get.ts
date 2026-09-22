import { trimBaseUrl } from "./mint";
import { AmtClientError } from "./types";

export interface GetTrackedMessageOptions {
  baseUrl: string;
  apiKey: string;
  messageId: string;
}

export interface TrackedMessageLink {
  id: string;
  original_url: string;
  tracked_url?: string;
}

export interface TrackedMessageEvent {
  id: string;
  type: string;
  created_at: string;
  classification: string | null;
  link_id?: string | null;
  original_url?: string | null;
}

/** GET /v1/messages/:id payload agents poll for opens, clicks, and status. */
export interface TrackedMessageView {
  message_id: string;
  to: string;
  subject: string | null;
  mode: string;
  open_tracking: boolean;
  opens: number | null;
  clicks: number;
  status: string;
  replied?: boolean;
  created_at?: string;
  first_open_at?: string | null;
  first_click_at?: string | null;
  last_classification?: string | null;
  last_event_at?: string | null;
  metadata?: Record<string, unknown> | null;
  pixel_url?: string | null;
  base_url?: string | null;
  links?: TrackedMessageLink[];
  events?: TrackedMessageEvent[];
}

export function shapeGetRequest(opts: GetTrackedMessageOptions): {
  url: string;
  headers: { Authorization: string };
} {
  if (!opts.baseUrl?.trim()) throw new AmtClientError("baseUrl is required");
  if (!opts.apiKey) throw new AmtClientError("apiKey is required");
  const id = opts.messageId?.trim() ?? "";
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) {
    throw new AmtClientError("messageId is required");
  }
  return {
    url: `${trimBaseUrl(opts.baseUrl)}/v1/messages/${encodeURIComponent(id)}`,
    headers: { Authorization: `Bearer ${opts.apiKey}` },
  };
}

export async function getTrackedMessage(opts: GetTrackedMessageOptions): Promise<TrackedMessageView> {
  const req = shapeGetRequest(opts);
  const res = await fetch(req.url, { method: "GET", headers: req.headers });
  const raw = await res.text();
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    throw new AmtClientError(`get failed: invalid JSON (${res.status})`, { status: res.status, body: raw });
  }
  if (!res.ok) {
    const errMsg =
      parsed && typeof parsed === "object" && parsed !== null && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : raw || res.statusText;
    throw new AmtClientError(`get failed: ${res.status} ${errMsg}`, { status: res.status, body: parsed });
  }
  const view = parsed as TrackedMessageView;
  if (!view?.message_id || typeof view.status !== "string") {
    throw new AmtClientError("get failed: response missing message_id / status", {
      status: res.status,
      body: parsed,
    });
  }
  return view;
}
