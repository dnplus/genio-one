-- Runtime projection delivery for the TypeScript Control Plane.
--
-- Runtime commands carry only an immutable Gateway Projection reference.  The
-- projection payload remains in genio_one_gateway_projections and is fetched
-- and verified by the runtime before applying native resources.  All rows are
-- tenant-scoped and a runtime instance has at most one command for a given
-- projection, so retries converge without duplicating delivery work.

create table if not exists genio_one_platform_runtime_registrations (
  tenant_id text not null,
  runtime_kind text not null default 'GATEWAY',
  runtime_id text not null,
  target_id text not null,
  oidc_client_id text not null,
  report_key_id text not null,
  report_public_key_pem text not null,
  status text not null default 'ACTIVE',
  row_revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, runtime_kind, runtime_id),
  check (runtime_kind = 'GATEWAY'),
  check (status in ('ACTIVE', 'DISABLED', 'REVOKED')),
  check (row_revision > 0),
  check (length(trim(tenant_id)) > 0),
  check (length(trim(runtime_id)) > 0),
  check (length(trim(target_id)) > 0),
  check (length(trim(oidc_client_id)) > 0),
  check (length(trim(report_key_id)) > 0),
  check (length(trim(report_public_key_pem)) > 0)
);
create index if not exists genio_one_platform_runtime_registrations_target_idx
  on genio_one_platform_runtime_registrations (tenant_id, target_id, status, runtime_id);

create table if not exists genio_one_platform_runtime_commands (
  tenant_id text not null,
  runtime_kind text not null default 'GATEWAY',
  runtime_id text not null,
  command_id text not null,
  projection_id text not null,
  publication_id text not null,
  projection_revision bigint not null,
  projection_digest text not null,
  command jsonb not null,
  state text not null default 'PENDING',
  failure_code text,
  failure_message text,
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  acknowledged_at timestamptz,
  failed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, runtime_kind, runtime_id, command_id),
  unique (tenant_id, runtime_kind, runtime_id, projection_id),
  foreign key (tenant_id, runtime_kind, runtime_id)
    references genio_one_platform_runtime_registrations
      (tenant_id, runtime_kind, runtime_id),
  foreign key (tenant_id, projection_id)
    references genio_one_gateway_projections (tenant_id, projection_id),
  foreign key (tenant_id, publication_id)
    references genio_one_publications (tenant_id, publication_id),
  check (runtime_kind = 'GATEWAY'),
  check (state in ('PENDING', 'ACKNOWLEDGED', 'FAILED')),
  check (projection_revision > 0),
  check (projection_digest ~ '^[a-f0-9]{64}$'),
  check (jsonb_typeof(command) = 'object'),
  check (length(trim(tenant_id)) > 0),
  check (length(trim(runtime_id)) > 0),
  check (length(trim(command_id)) > 0),
  check (length(trim(projection_id)) > 0),
  check (length(trim(publication_id)) > 0),
  check (failure_code is null or length(trim(failure_code)) > 0),
  check (failure_message is null or length(trim(failure_message)) > 0)
);

create index if not exists genio_one_platform_runtime_commands_pending_idx
  on genio_one_platform_runtime_commands
    (tenant_id, runtime_kind, runtime_id, state, created_at, command_id);

create table if not exists genio_one_platform_runtime_observed_states (
  tenant_id text not null,
  runtime_kind text not null default 'GATEWAY',
  runtime_id text not null,
  command_id text not null,
  report_id text not null,
  revision text not null,
  digest text not null,
  observed_status jsonb not null,
  observed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, runtime_kind, runtime_id),
  foreign key (tenant_id, runtime_kind, runtime_id)
    references genio_one_platform_runtime_registrations
      (tenant_id, runtime_kind, runtime_id),
  foreign key (tenant_id, runtime_kind, runtime_id, command_id)
    references genio_one_platform_runtime_commands
      (tenant_id, runtime_kind, runtime_id, command_id),
  check (runtime_kind = 'GATEWAY'),
  check (length(trim(tenant_id)) > 0),
  check (length(trim(runtime_id)) > 0),
  check (length(trim(command_id)) > 0),
  check (length(trim(report_id)) > 0),
  check (length(trim(revision)) > 0),
  check (digest ~ '^[a-f0-9]{64}$'),
  check (jsonb_typeof(observed_status) = 'object')
);

create table if not exists genio_one_platform_runtime_report_history (
  tenant_id text not null,
  runtime_kind text not null default 'GATEWAY',
  runtime_id text not null,
  report_id text not null,
  command_id text not null,
  revision text not null,
  digest text not null,
  report jsonb not null,
  outcome text not null,
  observed_at timestamptz not null default now(),
  primary key (tenant_id, runtime_kind, runtime_id, report_id),
  foreign key (tenant_id, runtime_kind, runtime_id)
    references genio_one_platform_runtime_registrations
      (tenant_id, runtime_kind, runtime_id),
  foreign key (tenant_id, runtime_kind, runtime_id, command_id)
    references genio_one_platform_runtime_commands
      (tenant_id, runtime_kind, runtime_id, command_id),
  check (runtime_kind = 'GATEWAY'),
  check (outcome in ('ACCEPTED', 'STALE')),
  check (length(trim(tenant_id)) > 0),
  check (length(trim(runtime_id)) > 0),
  check (length(trim(report_id)) > 0),
  check (length(trim(command_id)) > 0),
  check (length(trim(revision)) > 0),
  check (digest ~ '^[a-f0-9]{64}$'),
  check (jsonb_typeof(report) = 'object')
);

create index if not exists genio_one_runtime_reports_runtime_idx
  on genio_one_platform_runtime_report_history
    (tenant_id, runtime_kind, runtime_id, observed_at desc, report_id);

create table if not exists genio_one_platform_runtime_session_leases (
  tenant_id text not null,
  runtime_kind text not null default 'GATEWAY',
  runtime_id text not null,
  lease_id text not null,
  owner_id text not null,
  claimed_at timestamptz not null default now(),
  renewed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (tenant_id, runtime_kind, runtime_id),
  foreign key (tenant_id, runtime_kind, runtime_id)
    references genio_one_platform_runtime_registrations
      (tenant_id, runtime_kind, runtime_id),
  check (runtime_kind = 'GATEWAY'),
  check (length(trim(tenant_id)) > 0),
  check (length(trim(runtime_id)) > 0),
  check (length(trim(lease_id)) > 0),
  check (length(trim(owner_id)) > 0),
  check (expires_at > claimed_at)
);
