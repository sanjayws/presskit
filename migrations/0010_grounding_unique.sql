-- M-04: make grounding ingest idempotent under at-least-once queue delivery.
-- Remove any duplicate (campaign_id, hash) rows a prior check-then-insert race
-- may have created (keep the earliest rowid), then enforce uniqueness so a
-- concurrent duplicate insert is a no-op via ON CONFLICT instead of a dup row.
DELETE FROM grounding_docs WHERE rowid NOT IN (SELECT MIN(rowid) FROM grounding_docs GROUP BY campaign_id, hash);
CREATE UNIQUE INDEX idx_grounding_docs_dedup ON grounding_docs(campaign_id, hash);
