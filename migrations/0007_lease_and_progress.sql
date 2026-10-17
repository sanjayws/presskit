-- H-03 concurrency safety + P1 robustness.
-- TTL stage lease so at-least-once Queue delivery cannot run a stage twice.
ALTER TABLE runs ADD COLUMN lease_owner TEXT;
ALTER TABLE runs ADD COLUMN lease_until INTEGER NOT NULL DEFAULT 0;
-- Per-run regeneration counter (regeneration cost budget).
ALTER TABLE runs ADD COLUMN regen_count INTEGER NOT NULL DEFAULT 0;

-- Section-level checkpoint so a failed write retry resumes instead of restarting
-- the whole multi-call agentic generation.
CREATE TABLE article_progress (
  run_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  sections_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, topic_id)
);
