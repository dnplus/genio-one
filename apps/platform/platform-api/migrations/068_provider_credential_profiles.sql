create table if not exists genio_one_provider_credential_profile_revisions (
  tenant_id text not null,
  profile_id text not null,
  revision bigint not null,
  owner_organization_id text not null,
  display_name text not null,
  provider_type text not null,
  strategy jsonb not null,
  strategy_digest text not null,
  state text not null,
  created_by_subject_id text not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, profile_id, revision),
  foreign key (tenant_id, owner_organization_id)
    references genio_one_organizations (tenant_id, organization_id),
  check (revision > 0),
  check (length(trim(display_name)) > 0),
  check (provider_type in ('OPENAI', 'OMLX', 'OLLAMA', 'GCP_VERTEX_AI')),
  check (jsonb_typeof(strategy) = 'object'),
  check (strategy_digest ~ '^[a-f0-9]{64}$'),
  check (state in ('ACTIVE', 'REVOKED'))
);

create index if not exists genio_one_provider_credential_profiles_latest_idx
  on genio_one_provider_credential_profile_revisions
  (tenant_id, profile_id, revision desc);
