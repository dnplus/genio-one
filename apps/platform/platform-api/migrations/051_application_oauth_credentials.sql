create table if not exists genio_one_application_api_credentials (
  tenant_id text not null,
  credential_id text not null,
  application_id text not null,
  application_subject_id text not null,
  resource_id text not null,
  capability_id text not null,
  generation integer not null,
  kind text not null,
  oauth_client_id text not null,
  oauth_issuer text not null,
  oauth_audience text not null,
  oauth_scope text not null,
  identity_provider_id text,
  external_subject_id text,
  state text not null,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  valid_until timestamptz,
  revoked_at timestamptz,
  primary key (tenant_id, credential_id),
  foreign key (tenant_id, application_id)
    references genio_one_applications (tenant_id, application_id),
  foreign key (tenant_id, application_subject_id)
    references genio_one_subjects (tenant_id, subject_id),
  foreign key (tenant_id, resource_id)
    references genio_one_resources (tenant_id, resource_id),
  check (generation > 0),
  check (kind = 'OAUTH2'),
  check (state in ('PROVISIONING', 'ACTIVE', 'RETIRED', 'REVOKED')),
  check (length(trim(oauth_client_id)) > 0),
  check (length(trim(oauth_issuer)) > 0),
  check (length(trim(oauth_audience)) > 0),
  check (length(trim(oauth_scope)) > 0)
);

create unique index if not exists genio_one_application_api_credentials_generation_idx
  on genio_one_application_api_credentials
    (tenant_id, application_id, resource_id, capability_id, generation);

create unique index if not exists genio_one_application_api_credentials_active_idx
  on genio_one_application_api_credentials
    (tenant_id, application_id, resource_id, capability_id)
  where state = 'ACTIVE';

create index if not exists genio_one_application_api_credentials_application_idx
  on genio_one_application_api_credentials
    (tenant_id, application_id, created_at desc);
