CREATE TABLE IF NOT EXISTS genio_one_policy_drafts (
  tenant_id TEXT NOT NULL,
  policy_key TEXT NOT NULL,
  value JSONB NOT NULL,
  PRIMARY KEY (tenant_id, policy_key)
);

ALTER TABLE genio_one_first_party_policy_seeds
  ADD COLUMN IF NOT EXISTS rules JSONB NOT NULL DEFAULT '{"allowed_roles":["TENANT_ADMINISTRATOR"],"allowed_subject_ids":[]}';
