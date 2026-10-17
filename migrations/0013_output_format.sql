-- Output-format gate: the owner picks a target platform at topic selection
-- (WordPress/rich HTML, social post, plain text, markdown, or Word-compatible)
-- and the body is written + rendered for it. output_format is chosen per run and
-- stored on the campaign; each article records the format it was rendered for and
-- the rendered body in that format. Additive; default 'html' keeps old behaviour.
ALTER TABLE campaigns ADD COLUMN output_format TEXT NOT NULL DEFAULT 'html';
ALTER TABLE articles ADD COLUMN output_format TEXT NOT NULL DEFAULT 'html';
ALTER TABLE articles ADD COLUMN output_body TEXT NOT NULL DEFAULT '';
