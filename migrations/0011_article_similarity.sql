-- "No same/similar articles": flag (not block) a new article that closely
-- resembles one the same user generated before. similar_to holds the most
-- similar prior article's title; similar_score is the 0..1 similarity. Additive.
ALTER TABLE articles ADD COLUMN similar_to TEXT NOT NULL DEFAULT '';
ALTER TABLE articles ADD COLUMN similar_score REAL NOT NULL DEFAULT 0;
