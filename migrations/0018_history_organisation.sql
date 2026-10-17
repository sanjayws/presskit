ALTER TABLE runs ADD COLUMN archived_at INTEGER;
ALTER TABLE runs ADD COLUMN history_group TEXT NOT NULL DEFAULT '';
CREATE INDEX runs_history ON runs(archived_at, history_group, created_at);
-- Deletions hide content immediately; paged asset cleanup survives request/worker failure.
CREATE TABLE asset_cleanup (
  prefix TEXT PRIMARY KEY,
  cursor TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  sweep INTEGER NOT NULL DEFAULT 0,
  due_at INTEGER NOT NULL
);
