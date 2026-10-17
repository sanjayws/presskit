-- Keep the primary destination for backward compatibility; freeze all targets per run.
ALTER TABLE campaigns ADD COLUMN output_formats TEXT NOT NULL DEFAULT '[]';
ALTER TABLE runs ADD COLUMN output_formats TEXT NOT NULL DEFAULT '[]';
