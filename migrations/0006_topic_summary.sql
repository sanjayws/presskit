-- Two-step flow: each proposed topic now carries a short article summary shown
-- to the user before they pick an angle. Default '' keeps old rows valid.
ALTER TABLE topics ADD COLUMN summary TEXT NOT NULL DEFAULT '';
