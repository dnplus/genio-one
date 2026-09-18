-- Routing, policy and projection revisions for the TypeScript Control Plane.
--
-- A model route lease is deliberately absent here.  Valkey is the canonical
-- authority for the live (tenant, subject, client, public model, session)
-- lease.  PostgreSQL keeps only an immutable transition/audit ledger so route
-- changes can be investigated without pretending that a stale row is a live
-- lease.

create table if not exists tenant_control_plane_authority (
  tenant_id text primary key,
  authority text not null default 'RUST',
  row_revision bigint not null default 1,
  updated_at timestamptz not null default now(),
  check (authority in ('RUST', 'TYPESCRIPT')),
  check (row_revision > 0)
);

create table if not exists genio_one_enforcement_chain_revisions (
  tenant_id text not null,
  resource_id text not null,
  capability_id text not null,
  one_policy_revision bigint not null,
  eligible_connection_ids jsonb not null,
  chain jsonb not null,
  chain_digest text not null,
  row_revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, resource_id, capability_id, one_policy_revision),
  foreign key (tenant_id, resource_id)
    references genio_one_resources (tenant_id, resource_id),
  check (one_policy_revision > 0),
  check (row_revision > 0),
  check (jsonb_typeof(eligible_connection_ids) = 'array'),
  check (jsonb_array_length(eligible_connection_ids) > 0),
  check (jsonb_typeof(chain) = 'object'),
  check (length(trim(chain_digest)) > 0)
);

create table if not exists genio_one_gateway_projections (
  tenant_id text not null,
  projection_id text not null,
  resource_id text not null,
  capability_id text not null,
  revision bigint not null,
  resource_revision bigint not null,
  policy_revision bigint not null,
  digest text not null,
  signature jsonb not null,
  payload jsonb not null,
  row_revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, projection_id),
  unique (tenant_id, resource_id, capability_id, revision),
  foreign key (tenant_id, resource_id)
    references genio_one_resources (tenant_id, resource_id),
  foreign key (tenant_id, resource_id, capability_id, policy_revision)
    references genio_one_enforcement_chain_revisions
      (tenant_id, resource_id, capability_id, one_policy_revision),
  check (revision > 0),
  check (resource_revision > 0),
  check (policy_revision > 0),
  check (row_revision > 0),
  check (length(trim(digest)) > 0),
  check (jsonb_typeof(signature) = 'object'),
  check (jsonb_typeof(payload) = 'object')
);

create table if not exists genio_one_model_route_transitions (
  tenant_id text not null,
  transition_id text not null,
  subject_id text not null,
  client_id text not null,
  public_model_id text not null,
  session_id text not null,
  from_model_id text,
  to_model_id text not null,
  from_connection_id text,
  to_connection_id text not null,
  reason text not null,
  lease_revision bigint,
  occurred_at timestamptz not null default now(),
  primary key (tenant_id, transition_id),
  foreign key (tenant_id, public_model_id)
    references genio_one_public_models (tenant_id, model_id),
  check (length(trim(subject_id)) > 0),
  check (length(trim(client_id)) > 0),
  check (length(trim(public_model_id)) > 0),
  check (length(trim(session_id)) > 0),
  check (length(trim(to_model_id)) > 0),
  check (length(trim(to_connection_id)) > 0),
  check (length(trim(reason)) > 0),
  check (lease_revision is null or lease_revision > 0)
);

create index if not exists genio_one_route_transitions_tuple_idx
  on genio_one_model_route_transitions
    (tenant_id, subject_id, client_id, public_model_id, session_id, occurred_at);

-- All mutating capability commands may use this table for exactly-once
-- response replay.  request_digest prevents reusing an idempotency key for a
-- different command, while response_payload is the already-committed result.
create table if not exists genio_one_mutation_idempotency_receipts (
  tenant_id text not null,
  idempotency_key text not null,
  operation text not null,
  request_digest text not null,
  response_status integer not null,
  response_digest text not null,
  response_payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, idempotency_key),
  check (length(trim(idempotency_key)) > 0),
  check (length(trim(operation)) > 0),
  check (length(trim(request_digest)) > 0),
  check (response_status between 200 and 599),
  check (length(trim(response_digest)) > 0),
  check (jsonb_typeof(response_payload) = 'object')
);

create index if not exists genio_one_gateway_projections_revision_idx
  on genio_one_gateway_projections (tenant_id, revision desc);

create index if not exists genio_one_enforcement_chain_revision_idx
  on genio_one_enforcement_chain_revisions
    (tenant_id, resource_id, capability_id, one_policy_revision desc);
