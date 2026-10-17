-- The CTA button's action + target: how the call-to-action links out.
-- action ∈ {'', 'website', 'email', 'whatsapp', 'call'}; target is the raw
-- value the owner entered (a URL, email address or phone number). Additive.
ALTER TABLE campaigns ADD COLUMN cta_action TEXT NOT NULL DEFAULT '';
ALTER TABLE campaigns ADD COLUMN cta_target TEXT NOT NULL DEFAULT '';
