-- Speeds up the History sidebar query (runs joined to campaigns by owner).
CREATE INDEX IF NOT EXISTS idx_campaigns_user_created
  ON campaigns(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_grounding_campaign_hash
  ON grounding_docs(campaign_id, hash);
