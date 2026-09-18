-- Preserve the actor, reason and correlation for the governed revocation path.

alter table genio_one_model_entitlements
  add column if not exists revocation_reason text,
  add column if not exists revoked_at timestamptz,
  add column if not exists revoked_by_subject_id text,
  add column if not exists revocation_correlation_id text;
