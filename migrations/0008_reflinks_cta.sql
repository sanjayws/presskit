-- Reference links (woven into the article body as hyperlinks) and a preset
-- call-to-action block. Both are campaign-level "gears". Additive, non-destructive.
ALTER TABLE campaigns ADD COLUMN reference_links TEXT NOT NULL DEFAULT '[]';
ALTER TABLE campaigns ADD COLUMN cta TEXT NOT NULL DEFAULT '';
