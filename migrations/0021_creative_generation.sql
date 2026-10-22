ALTER TABLE campaigns ADD COLUMN inline_image_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN generation_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE runs ADD COLUMN inline_image_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN generation_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE runs ADD COLUMN writing_mode TEXT NOT NULL DEFAULT '';
CREATE TABLE brief_option_jobs (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  state TEXT NOT NULL DEFAULT 'queued', lease_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0, error TEXT
);
CREATE INDEX brief_option_jobs_owner ON brief_option_jobs(user_id,created_at);
