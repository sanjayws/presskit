CREATE TABLE campaign_images (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  description TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('hero','inline','attachment')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX campaign_images_active ON campaign_images(campaign_id,active,created_at);
-- Immutable metadata and asset references: editing a brief never changes old runs.
ALTER TABLE runs ADD COLUMN uploaded_images TEXT NOT NULL DEFAULT '[]';
