-- Agent Mail Track v0 — canonical D1 schema.
-- Applied in production via migrations/0001_init.sql
--   wrangler d1 migrations apply agent-mail-track --local
--   wrangler d1 migrations apply agent-mail-track --remote
--
-- Privacy: events store ip_hash (HMAC/SHA-256 of IP + TOKEN_SECRET), never raw IP.

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  recipient TEXT NOT NULL,
  subject TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('plain_looking', 'plain_only', 'html')),
  open_tracking INTEGER NOT NULL DEFAULT 1 CHECK (open_tracking IN (0, 1)),
  metadata TEXT,
  webhook_url TEXT,
  first_open_at TEXT,
  first_click_at TEXT,
  open_count INTEGER NOT NULL DEFAULT 0,
  click_count INTEGER NOT NULL DEFAULT 0,
  last_classification TEXT,
  last_event_at TEXT
);

CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  original_url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id)
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  link_id TEXT,
  type TEXT NOT NULL CHECK (type IN ('open', 'click')),
  created_at TEXT NOT NULL,
  ip_hash TEXT,
  user_agent TEXT,
  classification TEXT NOT NULL DEFAULT 'unknown',
  cf_country TEXT,
  deduped INTEGER NOT NULL DEFAULT 0 CHECK (deduped IN (0, 1)),
  FOREIGN KEY (message_id) REFERENCES messages(id),
  FOREIGN KEY (link_id) REFERENCES links(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_links_message ON links(message_id);
CREATE INDEX IF NOT EXISTS idx_events_message ON events(message_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_dedupe ON events(message_id, type, ip_hash, created_at);
