-- Versioned model-selection intent owned by a Resource capability.
--
-- The candidate list contains internal PublicModel IDs in policy order.
-- Provider model names, connection ids, credentials and runtime artifacts are
-- resolved later from the Public Model catalog and are intentionally absent.
-- tenant_id is the physical partition; owner_organization_id is the product
-- authority boundary and must match the Resource owner at write time.

create table if not exists genio_one_model_routing_policies (
  tenant_id text not null,
  routing_policy_id text not null,
  owner_organization_id text not null,
  resource_id text not null,
  capability_id text not null,
  routing_revision bigint not null,
  mode text not null,
  default_public_model_id text not null,
  candidate_public_model_ids jsonb not null,
  session_lease_seconds bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, routing_policy_id, routing_revision),
  unique (tenant_id, resource_id, capability_id, routing_revision),
  foreign key (tenant_id, owner_organization_id)
    references genio_one_organizations (tenant_id, organization_id),
  foreign key (tenant_id, resource_id)
    references genio_one_resources (tenant_id, resource_id),
  check (length(trim(tenant_id)) > 0),
  check (length(trim(routing_policy_id)) > 0),
  check (length(trim(owner_organization_id)) > 0),
  check (length(trim(resource_id)) > 0),
  check (length(trim(capability_id)) > 0),
  check (routing_revision > 0),
  check (mode in ('DETERMINISTIC', 'SESSION_LEASE')),
  check (length(trim(default_public_model_id)) > 0),
  check (jsonb_typeof(candidate_public_model_ids) = 'array'),
  check (candidate_public_model_ids <> '[]'::jsonb),
  check (
    (mode = 'DETERMINISTIC' and session_lease_seconds is null)
    or
    (mode = 'SESSION_LEASE' and session_lease_seconds between 1 and 86400)
  )
);

create index if not exists genio_one_model_routing_policies_scope_idx
  on genio_one_model_routing_policies
    (tenant_id, owner_organization_id, resource_id, capability_id, routing_revision desc);
