-- Optional user-supplied brief that guides featured-image generation.
ALTER TABLE campaigns ADD COLUMN image_brief TEXT NOT NULL DEFAULT '';
