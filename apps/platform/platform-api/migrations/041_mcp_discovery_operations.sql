create table if not exists genio_one_mcp_discovery_operations (
  tenant_id text not null,
  operation_id text not null,
  gateway_id text not null,
  resource_id text not null,
  connection_id text not null,
  requested_by_subject_id text not null,
  correlation_id text not null,
  state text not null default 'PENDING',
  runtime_id text,
  endpoint text not null,
  credential_ref text,
  downstream_identity jsonb not null,
  observation jsonb,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, operation_id),
  unique (tenant_id, correlation_id),
  check (state in ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  check (length(trim(endpoint)) > 0),
  check (jsonb_typeof(downstream_identity) = 'object'),
  check (
    (state in ('PENDING', 'RUNNING') and observation is null and completed_at is null)
    or (state = 'SUCCEEDED' and observation is not null and error_code is null and error_message is null and completed_at is not null)
    or (state = 'FAILED' and observation is null and error_code is not null and error_message is not null and completed_at is not null)
  )
);

create unique index if not exists genio_one_mcp_discovery_active_connection_idx
  on genio_one_mcp_discovery_operations (tenant_id, connection_id)
  where state in ('PENDING', 'RUNNING');

create index if not exists genio_one_mcp_discovery_gateway_queue_idx
  on genio_one_mcp_discovery_operations (tenant_id, gateway_id, state, created_at);
