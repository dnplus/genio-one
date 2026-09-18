-- GenioOne TypeScript Control Plane foundation.
--
-- This migration is intentionally normalized.  A Resource is the governed
-- object, a Connection is its concrete upstream, and Publication is a
-- separate aggregate.  Never put a Publication endpoint or request snapshot
-- back into genio_one_resources: publication revisions need an independent
-- lifecycle and digest.
--
-- Secrets are owned by the credential broker.  Only the opaque credential_ref
-- is retained by the Control Plane.

create table if not exists genio_one_organizations (
  tenant_id text not null,
  organization_id text not null,
  display_name text not null,
  slug text not null,
  row_revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, organization_id),
  unique (tenant_id, slug),
  check (row_revision > 0),
  check (length(trim(display_name)) > 0),
  check (length(trim(slug)) > 0)
);

create table if not exists genio_one_provider_profiles (
  tenant_id text not null,
  profile_id text not null,
  display_name text not null,
  provider_type text not null,
  protocol text not null,
  capabilities jsonb not null default '[]'::jsonb,
  model_discovery text not null,
  endpoint_required boolean not null,
  credential_required boolean not null,
  built_in boolean not null default false,
  row_revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, profile_id),
  check (row_revision > 0),
  check (jsonb_typeof(capabilities) = 'array'),
  check (length(trim(display_name)) > 0)
);

create table if not exists genio_one_resources (
  tenant_id text not null,
  resource_id text not null,
  display_name text not null,
  kind text not null,
  owner_organization_id text not null,
  authentication_strategy text not null,
  environment_id text not null,
  version text not null,
  lifecycle text not null default 'DRAFT',
  operational_state text not null default 'UNKNOWN',
  capabilities jsonb not null default '[]'::jsonb,
  enforcement_point_id text not null,
  row_revision bigint not null default 1,
  resource_digest text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, resource_id),
  foreign key (tenant_id, owner_organization_id)
    references genio_one_organizations (tenant_id, organization_id),
  check (row_revision > 0),
  check (lifecycle in ('DRAFT', 'PUBLISHED', 'DEPRECATED', 'RETIRED')),
  check (operational_state in ('UNKNOWN', 'HEALTHY', 'DEGRADED', 'UNAVAILABLE')),
  check (jsonb_typeof(capabilities) = 'array'),
  check (length(trim(display_name)) > 0),
  check (length(trim(version)) > 0)
);

create table if not exists genio_one_resource_connections (
  tenant_id text not null,
  resource_id text not null,
  connection_id text not null,
  display_name text not null,
  provider_type text not null,
  provider_profile_id text not null,
  endpoint text not null,
  -- This is an opaque reference only.  No API key, token, password or secret
  -- value may be written to this table.
  credential_ref text,
  status text not null default 'DRAFT',
  row_revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, resource_id, connection_id),
  foreign key (tenant_id, resource_id)
    references genio_one_resources (tenant_id, resource_id),
  foreign key (tenant_id, provider_profile_id)
    references genio_one_provider_profiles (tenant_id, profile_id),
  check (row_revision > 0),
  check (status in ('DRAFT', 'READY', 'DEGRADED', 'DISABLED')),
  check (length(trim(display_name)) > 0),
  check (length(trim(endpoint)) > 0),
  check (credential_ref is null or length(trim(credential_ref)) > 0)
);

create table if not exists genio_one_public_models (
  tenant_id text not null,
  model_id text not null,
  model_name text not null,
  display_name text not null,
  resource_id text not null,
  connection_id text not null,
  provider_profile_id text not null,
  visibility text not null,
  lifecycle text not null,
  capabilities jsonb not null default '[]'::jsonb,
  row_revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, model_id),
  unique (tenant_id, resource_id, model_name),
  foreign key (tenant_id, resource_id, connection_id)
    references genio_one_resource_connections (tenant_id, resource_id, connection_id),
  foreign key (tenant_id, provider_profile_id)
    references genio_one_provider_profiles (tenant_id, profile_id),
  check (row_revision > 0),
  check (visibility in ('PUBLIC', 'PRIVATE')),
  check (lifecycle in ('PUBLISHED', 'DEPRECATED')),
  check (jsonb_typeof(capabilities) = 'array'),
  check (length(trim(model_name)) > 0),
  check (length(trim(display_name)) > 0)
);

-- Publication owns the routable endpoint and its review snapshot.  The
-- resource lifecycle remains authoritative for whether the Resource is
-- usable; this aggregate records the endpoint revision that was compiled.
create table if not exists genio_one_publications (
  tenant_id text not null,
  publication_id text not null,
  resource_id text not null,
  endpoint_revision bigint not null,
  resource_revision bigint not null,
  resource_digest text not null,
  policy_revision bigint not null,
  gateway_id text not null,
  hostname text not null,
  base_path text not null default '/',
  visibility text not null default 'PRIVATE',
  publication_state text not null default 'DRAFT',
  dns_management text not null default 'EXTERNAL',
  dns_proof_status text not null default 'PENDING',
  dns_proof jsonb not null default '{}'::jsonb,
  request_snapshot jsonb not null default '{}'::jsonb,
  review_snapshot jsonb not null default '{}'::jsonb,
  row_revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, publication_id),
  unique (tenant_id, resource_id, endpoint_revision),
  foreign key (tenant_id, resource_id)
    references genio_one_resources (tenant_id, resource_id),
  check (endpoint_revision > 0),
  check (resource_revision > 0),
  check (policy_revision >= 0),
  check (row_revision > 0),
  check (visibility in ('PRIVATE', 'REQUEST', 'PUBLIC')),
  check (publication_state in ('DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'DEPRECATED', 'RETIRED')),
  check (dns_management in ('PLATFORM_MANAGED', 'EXTERNAL')),
  check (dns_proof_status in ('PENDING', 'VERIFIED', 'FAILED')),
  check (jsonb_typeof(dns_proof) = 'object'),
  check (jsonb_typeof(request_snapshot) = 'object'),
  check (jsonb_typeof(review_snapshot) = 'object'),
  check (hostname ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$'),
  check (base_path like '/%')
);

create index if not exists genio_one_resources_owner_idx
  on genio_one_resources (tenant_id, owner_organization_id, lifecycle);

create index if not exists genio_one_connections_resource_idx
  on genio_one_resource_connections (tenant_id, resource_id, status);

create index if not exists genio_one_publications_resource_idx
  on genio_one_publications (tenant_id, resource_id, publication_state);
