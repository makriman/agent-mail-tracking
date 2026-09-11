export type Mode = "plain_looking" | "plain_only" | "html";

export const MODES: readonly Mode[] = ["plain_looking", "plain_only", "html"];

export type EventType = "open" | "click";

export type Classification =
  | "gmail_proxy"
  | "apple_mpp"
  | "security_scanner"
  | "human_likely"
  | "unknown";

/** Confidence hierarchy, exposed as `status` on message payloads. */
export type Status =
  | "replied"
  | "clicked"
  | "high_confidence_open"
  | "proxy_open"
  | "no_signal";

export interface CreateMessageBody {
  to: string;
  subject?: string;
  text?: string;
  html?: string;
  mode?: Mode;
  metadata?: Record<string, unknown>;
  webhook_url?: string;
  base_url?: string;
}

export interface LinkRecord {
  id: string;
  original_url: string;
  tracked_url: string;
}

export interface MessageRow {
  id: string;
  created_at: string;
  recipient: string;
  subject: string | null;
  mode: Mode;
  open_tracking: number;
  metadata: string | null;
  webhook_url: string | null;
  first_open_at: string | null;
  first_click_at: string | null;
  open_count: number;
  click_count: number;
  last_classification: string | null;
  last_event_at: string | null;
}

export interface LinkRow {
  id: string;
  message_id: string;
  original_url: string;
  created_at: string;
}

export interface EventRow {
  id: string;
  message_id: string;
  link_id: string | null;
  type: EventType;
  created_at: string;
  ip_hash: string | null;
  user_agent: string | null;
  classification: Classification;
  cf_country: string | null;
  deduped: number;
  original_url?: string | null;
}
