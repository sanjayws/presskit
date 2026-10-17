-- Durable delivery intent survives queue hand-off failure, timeouts and DLQ expiry.
CREATE TABLE run_recovery (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  retrying INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX run_recovery_due ON run_recovery(due_at);
-- Uploaded binaries are saved before extraction, keeping paid work off HTTP requests.
CREATE TABLE source_uploads (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  doc_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL
);
