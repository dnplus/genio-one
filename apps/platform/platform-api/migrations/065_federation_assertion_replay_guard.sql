create table if not exists genio_one_federation_assertion_uses (
  tenant_id text not null,
  trust_id text not null,
  trust_revision bigint not null,
  assertion_jti_sha256 text not null check (assertion_jti_sha256 ~ '^[a-f0-9]{64}$'),
  correlation_id text not null,
  expires_at timestamptz not null,
  used_at timestamptz not null default now(),
  primary key (tenant_id, trust_id, trust_revision, assertion_jti_sha256),
  constraint genio_one_federation_assertion_correlation_unique unique (tenant_id, correlation_id),
  foreign key (tenant_id, trust_id, trust_revision)
    references genio_one_federation_trust_revisions (tenant_id, trust_id, revision)
);

create index if not exists genio_one_federation_assertion_expiry_idx
  on genio_one_federation_assertion_uses (expires_at);
