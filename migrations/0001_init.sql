-- AI Blog Draft Studio — initial schema. Export-only. No site/credential tables.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE campaigns (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  idea TEXT NOT NULL,
  grounding_refs TEXT NOT NULL DEFAULT '[]',
  voice_profile TEXT NOT NULL DEFAULT 'ms-en',
  max_words INTEGER NOT NULL DEFAULT 650,
  created_at INTEGER NOT NULL
);

CREATE TABLE grounding_docs (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  kind TEXT NOT NULL,                 -- 'url' | 'upload'
  source TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  hash TEXT NOT NULL
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  state TEXT NOT NULL DEFAULT 'drafting_topics',
  error TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE topics (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  title TEXT NOT NULL,
  angle TEXT NOT NULL,
  primary_kw TEXT NOT NULL,
  volume INTEGER,
  difficulty INTEGER,
  selected INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE articles (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  title TEXT NOT NULL,
  body_html TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  slug TEXT NOT NULL,
  meta_desc TEXT NOT NULL,
  key_phrases TEXT NOT NULL DEFAULT '[]',
  svg_r2_key TEXT,
  png_r2_key TEXT
);

CREATE INDEX idx_runs_campaign ON runs(campaign_id);
CREATE INDEX idx_topics_run ON topics(run_id);
CREATE INDEX idx_articles_run ON articles(run_id);
