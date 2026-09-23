import { messageStatus } from "./confidence";
import type { Classification, EventRow, EventType, LinkRow, MessageRow, Mode } from "./types";

const DEDUPE_MS = 60 * 60 * 1000;

/**
 * Same IP hammering one open or click token must not fill D1.
 * The first hit from that IP on that token in the hour is always stored (first-open / timeline).
 * A different IP is a different bucket, so spam cannot consume someone else's first event.
 */
export const EVENT_WRITES_PER_IP_TOKEN_PER_HOUR = 8;

/** Rolling window for successful POST /v1/messages inserts. */
export const MINT_WINDOW_MS = 60 * 60 * 1000;

/**
 * v0 has one API_KEY. Every successful mint is that key's bucket.
 * 1000 leaves room for two documented 500-row mint-only waves in the same hour.
 * The count is rows in D1, so it survives a new isolate.
 */
export const MINT_WRITES_PER_KEY_PER_HOUR = 1000;

export function eventWriteAllowed(inWindow: number): boolean {
  if (!Number.isFinite(inWindow)) return false;
  return inWindow < EVENT_WRITES_PER_IP_TOKEN_PER_HOUR;
}

export function mintWriteAllowed(inWindow: number): boolean {
  if (!Number.isFinite(inWindow)) return false;
  return inWindow < MINT_WRITES_PER_KEY_PER_HOUR;
}

export interface MintWindowUsage {
  inWindow: number;
  /** Oldest message timestamp inside the window, when any row counts. */
  oldest: string | null;
}

export async function mintWindowUsage(db: D1Database, nowIso: string): Promise<MintWindowUsage> {
  const startMs = Date.parse(nowIso);
  if (!Number.isFinite(startMs)) return { inWindow: Number.NaN, oldest: null };
  const windowStart = new Date(startMs - MINT_WINDOW_MS).toISOString();
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS in_window, MIN(created_at) AS oldest
       FROM messages
       WHERE created_at >= ?`,
    )
    .bind(windowStart)
    .first<{ in_window: number | string | null; oldest: string | null }>();
  return {
    inWindow: Number(row?.in_window ?? 0),
    oldest: row?.oldest ?? null,
  };
}

/** Seconds until the oldest in-window mint falls out of the rolling hour. */
export function mintRetryAfterSeconds(nowIso: string, oldestIso: string | null): number {
  const nowMs = Date.parse(nowIso);
  const oldestMs = oldestIso ? Date.parse(oldestIso) : Number.NaN;
  const retryMs =
    Number.isFinite(nowMs) && Number.isFinite(oldestMs) ? oldestMs + MINT_WINDOW_MS : nowMs + MINT_WINDOW_MS;
  const secs = Math.ceil((retryMs - nowMs) / 1000);
  if (!Number.isFinite(secs) || secs < 1) return 1;
  return secs;
}

export async function insertMessage(
  db: D1Database,
  row: {
    id: string;
    created_at: string;
    recipient: string;
    subject: string | null;
    mode: Mode;
    open_tracking: boolean;
    metadata: string | null;
    webhook_url: string | null;
    base_url: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO messages (
        id, created_at, recipient, subject, mode, open_tracking, metadata, webhook_url, base_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.created_at,
      row.recipient,
      row.subject,
      row.mode,
      row.open_tracking ? 1 : 0,
      row.metadata,
      row.webhook_url,
      row.base_url,
    )
    .run();
}

export async function insertLinks(
  db: D1Database,
  links: { id: string; message_id: string; original_url: string; created_at: string }[],
): Promise<void> {
  if (links.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO links (id, message_id, original_url, created_at) VALUES (?, ?, ?, ?)`,
  );
  await db.batch(links.map((l) => stmt.bind(l.id, l.message_id, l.original_url, l.created_at)));
}

export async function getMessage(db: D1Database, id: string): Promise<MessageRow | null> {
  return db.prepare(`SELECT * FROM messages WHERE id = ?`).bind(id).first<MessageRow>();
}

export async function listMessages(db: D1Database, limit: number): Promise<MessageRow[]> {
  const res = await db
    .prepare(`SELECT * FROM messages ORDER BY created_at DESC LIMIT ?`)
    .bind(limit)
    .all<MessageRow>();
  return res.results ?? [];
}

export async function listLinks(db: D1Database, messageId: string): Promise<LinkRow[]> {
  const res = await db
    .prepare(`SELECT * FROM links WHERE message_id = ?`)
    .bind(messageId)
    .all<LinkRow>();
  return res.results ?? [];
}

export async function getLink(db: D1Database, id: string): Promise<LinkRow | null> {
  return db.prepare(`SELECT * FROM links WHERE id = ?`).bind(id).first<LinkRow>();
}

export async function listEvents(db: D1Database, messageId: string): Promise<EventRow[]> {
  const res = await db
    .prepare(
      `SELECT e.*, l.original_url AS original_url
       FROM events e
       LEFT JOIN links l ON l.id = e.link_id
       WHERE e.message_id = ?
       ORDER BY e.created_at ASC`,
    )
    .bind(messageId)
    .all<EventRow>();
  return res.results ?? [];
}

/** Message ids that have at least one non-proxy open. One query so list HTML and JSON share the same signal. */
export async function listHumanOpenIds(db: D1Database, messageIds: readonly string[]): Promise<Set<string>> {
  if (messageIds.length === 0) return new Set();
  const placeholders = messageIds.map(() => "?").join(", ");
  const res = await db
    .prepare(
      `SELECT DISTINCT message_id FROM events
       WHERE type = 'open' AND classification = 'human_likely'
         AND message_id IN (${placeholders})`,
    )
    .bind(...messageIds)
    .all<{ message_id: string }>();
  return new Set((res.results ?? []).map((row) => row.message_id));
}

export async function hadHumanOpen(db: D1Database, messageId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT id FROM events
       WHERE message_id = ? AND type = 'open' AND classification = 'human_likely'
       LIMIT 1`,
    )
    .bind(messageId)
    .first<{ id: string }>();
  return Boolean(row);
}

export interface RecordEventInput {
  id: string;
  message_id: string;
  link_id: string | null;
  type: EventType;
  created_at: string;
  ip_hash: string | null;
  user_agent: string | null;
  classification: Classification;
  cf_country: string | null;
}

export interface RecordEventResult {
  first: boolean;
  deduped: boolean;
  /** True when the hourly or lifetime cap skipped the insert. */
  rateLimited: boolean;
  message: MessageRow;
}

export async function recordEvent(db: D1Database, input: RecordEventInput): Promise<RecordEventResult | null> {
  const message = await getMessage(db, input.message_id);
  if (!message) return null;
  if (input.type === "open" && !message.open_tracking) {
    return { first: false, deduped: true, rateLimited: false, message };
  }

  const windowStart = new Date(Date.parse(input.created_at) - DEDUPE_MS).toISOString();
  const tokenKey = input.type === "click" ? (input.link_id ?? "") : "";
  const usage = await db
    .prepare(
      `SELECT COUNT(*) AS in_window
       FROM events
       WHERE message_id = ? AND type = ? AND ifnull(ip_hash, '') = ? AND ifnull(link_id, '') = ?
         AND created_at >= ?`,
    )
    .bind(input.message_id, input.type, input.ip_hash ?? "", tokenKey, windowStart)
    .first<{ in_window: number | string | null }>();
  const inWindow = Number(usage?.in_window ?? 0);
  const firstSignalMissing = input.type === "open" ? !message.first_open_at : !message.first_click_at;
  if (!eventWriteAllowed(inWindow) && !firstSignalMissing) {
    return { first: false, deduped: true, rateLimited: true, message };
  }

  const prior = await db
    .prepare(
      `SELECT id FROM events
       WHERE message_id = ? AND type = ? AND ifnull(ip_hash, '') = ? AND ifnull(user_agent, '') = ?
         AND created_at >= ?
       LIMIT 1`,
    )
    .bind(input.message_id, input.type, input.ip_hash ?? "", input.user_agent ?? "", windowStart)
    .first<{ id: string }>();

  const deduped = Boolean(prior);
  await db
    .prepare(
      `INSERT INTO events (
        id, message_id, link_id, type, created_at, ip_hash, user_agent, classification, cf_country, deduped
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.message_id,
      input.link_id,
      input.type,
      input.created_at,
      input.ip_hash,
      input.user_agent,
      input.classification,
      input.cf_country,
      deduped ? 1 : 0,
    )
    .run();

  const isOpen = input.type === "open";
  const first = !deduped && (isOpen ? !message.first_open_at : !message.first_click_at);

  if (!deduped) {
    if (isOpen) {
      await db
        .prepare(
          `UPDATE messages SET
             open_count = open_count + 1,
             first_open_at = COALESCE(first_open_at, ?),
             last_classification = ?,
             last_event_at = ?
           WHERE id = ?`,
        )
        .bind(input.created_at, input.classification, input.created_at, input.message_id)
        .run();
    } else {
      await db
        .prepare(
          `UPDATE messages SET
             click_count = click_count + 1,
             first_click_at = COALESCE(first_click_at, ?),
             last_classification = ?,
             last_event_at = ?
           WHERE id = ?`,
        )
        .bind(input.created_at, input.classification, input.created_at, input.message_id)
        .run();
    }
  }

  const updated = (await getMessage(db, input.message_id)) ?? message;
  return { first, deduped, rateLimited: false, message: updated };
}

export function serializeMessage(
  row: MessageRow,
  extras: {
    humanOpen?: boolean;
    links?: { id: string; original_url: string; tracked_url?: string }[];
    events?: EventRow[];
    pixel_url?: string | null;
    text?: string | null;
    html?: string | null;
    base_url?: string | null;
  } = {},
) {
  const openTracking = Boolean(row.open_tracking);
  const status = messageStatus(row, extras.humanOpen);
  return {
    message_id: row.id,
    to: row.recipient,
    subject: row.subject,
    mode: row.mode,
    open_tracking: openTracking,
    opens: openTracking ? row.open_count : null,
    clicks: row.click_count,
    status,
    replied: false,
    created_at: row.created_at,
    first_open_at: openTracking ? row.first_open_at : null,
    first_click_at: row.first_click_at,
    last_classification: row.last_classification,
    last_event_at: row.last_event_at,
    metadata: parseMetadata(row.metadata),
    ...(extras.base_url !== undefined ? { base_url: extras.base_url } : {}),
    ...(extras.pixel_url !== undefined ? { pixel_url: extras.pixel_url } : {}),
    ...(extras.text !== undefined ? { text: extras.text } : {}),
    ...(extras.html !== undefined ? { html: extras.html } : {}),
    ...(extras.links ? { links: extras.links } : {}),
    ...(extras.events
      ? {
          events: extras.events.map((e) => ({
            id: e.id,
            type: e.type,
            created_at: e.created_at,
            classification: e.classification,
            ip_hash: e.ip_hash,
            user_agent: e.user_agent,
            cf_country: e.cf_country,
            deduped: Boolean(e.deduped),
            link_id: e.link_id,
            original_url: e.original_url ?? null,
          })),
        }
      : {}),
  };
}

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}
