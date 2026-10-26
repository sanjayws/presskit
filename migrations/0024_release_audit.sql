ALTER TABLE articles ADD COLUMN content_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN brief_snapshot TEXT;
CREATE TABLE image_read_leases (
  asset_key TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  lease_until INTEGER NOT NULL
);
CREATE INDEX image_read_leases_expiry ON image_read_leases(lease_until);
