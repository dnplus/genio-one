ALTER TABLE genio_one_policy_drafts ADD COLUMN last_version integer NOT NULL DEFAULT 1;
UPDATE genio_one_policy_drafts SET last_version = (value->>'version')::integer;
