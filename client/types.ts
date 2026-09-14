export type Mode = "plain_looking" | "plain_only" | "html";

export type SendVia = "smtp" | "gmail_raw";

export interface MintTrackedMessageOptions {
  baseUrl: string;
  apiKey: string;
  to: string;
  from?: string;
  subject?: string;
  text?: string;
  html?: string;
  mode?: Mode;
  metadata?: Record<string, unknown>;
  webhookUrl?: string;
  /** Persisted pixel/click origin (`base_url` on POST /v1/messages). */
  trackingBaseUrl?: string;
}

export interface MintedLink {
  id: string;
  original_url: string;
  tracked_url: string;
}

/** Subset of POST /v1/messages 201 used to send. Extra fields are preserved. */
export interface MintedMessage {
  message_id: string;
  mode: Mode | string;
  open_tracking: boolean;
  opens: number | null;
  clicks: number;
  status: string;
  to: string;
  from: string | null;
  subject: string | null;
  text: string | null;
  html: string | null;
  raw_mime: string;
  raw_base64url: string;
  pixel_url: string | null;
  base_url: string;
  links: MintedLink[];
  created_at: string;
}

export interface SmtpSendOptions {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  to: string;
  rawMime: string;
  /** Implicit TLS (port 465). Default true when port is 465. */
  secure?: boolean;
  timeoutMs?: number;
  ehloName?: string;
}

export interface SmtpSendResult {
  accepted: true;
  code: number;
  response: string;
}

export interface GoogleAuthLike {
  getAccessToken: () => Promise<string | null | undefined | { token?: string | null }>;
}

export type GmailAuth = { accessToken: string } | { googleauth: GoogleAuthLike };

export interface GmailSendResult {
  id?: string;
  threadId?: string;
  labelIds?: string[];
}

export class AmtClientError extends Error {
  readonly status?: number;
  readonly body?: unknown;

  constructor(message: string, opts?: { status?: number; body?: unknown }) {
    super(message);
    this.name = "AmtClientError";
    this.status = opts?.status;
    this.body = opts?.body;
  }
}
