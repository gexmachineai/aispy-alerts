-- AISPYALERTS subscribers
-- Email-only signup is the primary path (SIGNAL BCC via Resend).
-- webhook_url / sender_key_encrypted stay NOT NULL for existing D1 compatibility:
-- use empty strings ('') for email-only rows. Usable webhooks are legacy/optional.
CREATE TABLE IF NOT EXISTS subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT,
  webhook_url TEXT NOT NULL,              -- '' when email-only (primary)
  sender_key_encrypted TEXT NOT NULL,     -- '' when email-only (primary)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  active INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_subscribers_active ON subscribers(active);
