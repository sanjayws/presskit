-- Editorial controls (all optional): what the article must include, what it must
-- exclude, and a 1..5 bias level (1 = strictly neutral/honest, 5 = strongly
-- promotional toward the grounding source). Additive; safe defaults keep existing
-- campaigns unchanged (bias 3 = balanced).
ALTER TABLE campaigns ADD COLUMN include_ideas TEXT NOT NULL DEFAULT '';
ALTER TABLE campaigns ADD COLUMN exclude_ideas TEXT NOT NULL DEFAULT '';
ALTER TABLE campaigns ADD COLUMN bias_level INTEGER NOT NULL DEFAULT 3;
