-- Image-only requests must never rewind or rewrite a completed article run.
CREATE TABLE article_image_jobs (
  article_id TEXT PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('retry', 'new')),
  state TEXT NOT NULL CHECK (state IN ('queued', 'working', 'ready', 'failed')),
  error TEXT,
  source_brief_key TEXT,
  requested_at INTEGER NOT NULL,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0
);
