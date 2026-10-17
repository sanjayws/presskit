-- H-01 fix: the output format is a PER-RUN decision, not campaign-wide state.
-- Storing it on the shared campaign let overlapping runs (or concurrent submits)
-- clobber each other's format. Move it to the run, set atomically with the
-- awaiting_topic_selection -> writing transition. articles.output_format remains
-- the historical record of what each finished article was rendered as.
ALTER TABLE runs ADD COLUMN output_format TEXT NOT NULL DEFAULT 'html';
