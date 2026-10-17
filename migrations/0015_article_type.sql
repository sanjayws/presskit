-- Article type (campaign gear): orients BOTH topic research and how the piece
-- is written. 'article' (standard), 'comparison', 'listicle', 'howto', 'news',
-- 'blog', 'opinion', 'review'. Reads are guarded by articleTypeByValue().
ALTER TABLE campaigns ADD COLUMN article_type TEXT NOT NULL DEFAULT 'article';
