-- First concrete Entitlement projection used by AI model routing.

create table genio_one_model_entitlements (
  tenant_id text not null,
  entitlement_id text not null,
  subject_id text,
  client_id text,
  public_model_id text not null,
  state text not null default 'ACTIVE',
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  row_revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, entitlement_id),
  foreign key (tenant_id, public_model_id)
    references genio_one_public_models (tenant_id, model_id),
  check (subject_id is not null or client_id is not null),
  check (state in ('ACTIVE', 'REVOKED')),
  check (expires_at is null or expires_at > starts_at),
  check (row_revision > 0)
);

create index genio_one_model_entitlements_effective_idx
  on genio_one_model_entitlements
    (tenant_id, subject_id, client_id, public_model_id, state, starts_at, expires_at);
