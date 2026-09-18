ALTER TABLE genio_one_first_party_policy_seeds
  DROP CONSTRAINT IF EXISTS genio_one_first_party_policy_seeds_policy_revision_check;

ALTER TABLE genio_one_first_party_policy_seeds
  ADD CONSTRAINT genio_one_first_party_policy_seeds_positive_revision CHECK (policy_revision >= 1);

UPDATE genio_one_policy_drafts
SET value = (value #>> '{}')::jsonb
WHERE jsonb_typeof(value) = 'string';
