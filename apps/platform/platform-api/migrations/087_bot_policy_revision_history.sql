CREATE TABLE IF NOT EXISTS genio_one_bot_policy_revisions (
  tenant_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  policy_revision INTEGER NOT NULL,
  rules JSONB NOT NULL,
  published_by TEXT,
  published_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, policy_id, policy_revision)
);

INSERT INTO genio_one_bot_policy_revisions (tenant_id, policy_id, policy_revision, rules, published_by, published_at)
SELECT tenant_id, policy_id, policy_revision, rules, NULL, EXTRACT(EPOCH FROM updated_at)::BIGINT
FROM genio_one_first_party_policy_seeds
ON CONFLICT DO NOTHING;
