-- Local suspension of a Subject. Revoking access in the identity provider does
-- not end a session GenioOne already accepted, and a tenant whose provider is
-- operated by another team needs to stop someone without waiting for it, so the
-- Control Plane keeps its own authoritative switch.
alter table genio_one_subjects
  add column if not exists suspended_at timestamptz,
  add column if not exists suspended_by text,
  add column if not exists suspension_reason text;

create index if not exists genio_one_subjects_suspended_at_idx
  on genio_one_subjects (tenant_id, suspended_at)
  where suspended_at is not null;
