create table genio_one_endpoint_credentials (
  credential_id text primary key,
  tenant_id text not null,
  device_id text not null,
  subject_id text not null,
  kind text not null check (kind in ('BOOTSTRAP', 'RUNTIME')),
  token_hash text not null unique,
  expires_at bigint not null check (expires_at >= 0),
  consumed_at bigint,
  revoked_at bigint,
  correlation_id text,
  check (kind = 'BOOTSTRAP' or consumed_at is null)
);
create unique index genio_one_endpoint_bootstrap_correlation_idx
  on genio_one_endpoint_credentials (tenant_id, subject_id, correlation_id) where kind = 'BOOTSTRAP';
create index genio_one_endpoint_credentials_device_idx
  on genio_one_endpoint_credentials (tenant_id, device_id);
