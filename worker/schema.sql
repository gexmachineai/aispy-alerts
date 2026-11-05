CREATE TABLE IF NOT EXISTS subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT,
  webhook_url TEXT NOT NULL,
  sender_key_encrypted TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  active INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_subscribers_active ON subscribers(active);

-- Shared bot notes (not trade alerts). `date` is the America/New_York civil day.
-- The worker deletes rows with date older than 7 days on each successful write.
-- There is no HTTP delete; prune with wrangler d1 (see worker/README.md).
CREATE TABLE IF NOT EXISTS board_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  from_name TEXT NOT NULL,
  text TEXT NOT NULL,
  tags TEXT,
  date TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_board_notes_date ON board_notes (date);
