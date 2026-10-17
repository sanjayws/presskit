-- Article + image generation "gears": persona, tone, temperature, signature,
-- and the featured-image style.
ALTER TABLE campaigns ADD COLUMN persona TEXT NOT NULL DEFAULT '';
ALTER TABLE campaigns ADD COLUMN tone TEXT NOT NULL DEFAULT '';
ALTER TABLE campaigns ADD COLUMN temperature REAL NOT NULL DEFAULT 0.6;
ALTER TABLE campaigns ADD COLUMN signature TEXT NOT NULL DEFAULT '';
ALTER TABLE campaigns ADD COLUMN image_style TEXT NOT NULL DEFAULT '';
