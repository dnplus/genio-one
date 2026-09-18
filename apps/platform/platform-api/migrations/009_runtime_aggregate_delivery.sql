-- Aggregate Runtime Protocol v2 delivery.
--
-- Runtime registrations and session leases remain owned by migration 007.
-- Protocol capabilities, aggregate commands, observations, and report history
-- are deliberately separate from the v1 per-projection tables so a v2
-- release cannot be partially represented by nullable v1 columns.

create table if not exists genio_one_platform_runtime_capabilities (
  tenant_id text not null,
  runtime_kind text not null default 'GATEWAY',
  runtime_id text not null,
  protocol_versions jsonb not null,
  preferred_protocol_version text not null,
  delivery_mode text not null default 'AGGREGATE_RELEASE',
  row_revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, runtime_kind, runtime_id),
  foreign key (tenant_id, runtime_kind, runtime_id)
    references genio_one_platform_runtime_registrations
      (tenant_id, runtime_kind, runtime_id)
    on delete restrict,
  check (runtime_kind = 'GATEWAY'),
  check (jsonb_typeof(protocol_versions) = 'array'),
  check (protocol_versions @> '["genio.one.runtime.v2"]'::jsonb),
  check (preferred_protocol_version = 'genio.one.runtime.v2'),
  check (delivery_mode = 'AGGREGATE_RELEASE'),
  check (row_revision > 0),
  check (length(trim(tenant_id)) > 0),
  check (length(trim(runtime_id)) > 0)
);

create table if not exists genio_one_platform_runtime_aggregate_commands (
  tenant_id text not null,
  runtime_kind text not null default 'GATEWAY',
  runtime_id text not null,
  command_id text not null,
  release_id text not null,
  gateway_id text not null,
  head_revision bigint not null,
  package_digest text not null,
  projection_count bigint not null,
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
  unique (tenant_id, runtime_kind, runtime_id, release_id),
  foreign key (tenant_id, runtime_kind, runtime_id)
    references genio_one_platform_runtime_registrations
      (tenant_id, runtime_kind, runtime_id)
    on delete restrict,
  check (runtime_kind = 'GATEWAY'),
  check (length(trim(tenant_id)) > 0),
  check (length(trim(runtime_id)) > 0),
  check (length(trim(command_id)) > 0),
  check (length(trim(release_id)) > 0),
  check (length(trim(gateway_id)) > 0),
  check (head_revision > 0),
  check (package_digest ~ '^[a-f0-9]{64}$'),
  check (projection_count >= 0),
  check (jsonb_typeof(command) = 'object'),
  check (state in ('PENDING', 'ACKNOWLEDGED', 'FAILED')),
  check (failure_code is null or length(trim(failure_code)) > 0),
  check (failure_message is null or length(trim(failure_message)) > 0)
);

create index if not exists genio_one_platform_runtime_aggregate_commands_pending_idx
  on genio_one_platform_runtime_aggregate_commands
    (tenant_id, runtime_kind, runtime_id, state, created_at, command_id);

create table if not exists genio_one_platform_runtime_aggregate_observed_states (
  tenant_id text not null,
  runtime_kind text not null default 'GATEWAY',
  runtime_id text not null,
  command_id text not null,
  report_id text not null,
  revision text not null,
  digest text not null,
  applied_release jsonb,
  observed_status jsonb not null,
  observed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, runtime_kind, runtime_id),
  foreign key (tenant_id, runtime_kind, runtime_id)
    references genio_one_platform_runtime_registrations
      (tenant_id, runtime_kind, runtime_id)
    on delete restrict,
  foreign key (tenant_id, runtime_kind, runtime_id, command_id)
    references genio_one_platform_runtime_aggregate_commands
      (tenant_id, runtime_kind, runtime_id, command_id)
    on delete restrict,
  check (runtime_kind = 'GATEWAY'),
  check (length(trim(tenant_id)) > 0),
  check (length(trim(runtime_id)) > 0),
  check (length(trim(command_id)) > 0),
  check (length(trim(report_id)) > 0),
  check (length(trim(revision)) > 0),
  check (digest ~ '^[a-f0-9]{64}$'),
  check (applied_release is null or jsonb_typeof(applied_release) = 'object'),
  check (jsonb_typeof(observed_status) = 'object')
);

create table if not exists genio_one_platform_runtime_aggregate_report_history (
  tenant_id text not null,
  runtime_kind text not null default 'GATEWAY',
  runtime_id text not null,
  report_id text not null,
  command_id text not null,
  release_id text not null,
  package_digest text not null,
  revision text not null,
  digest text not null,
  report jsonb not null,
  outcome text not null,
  observed_at timestamptz not null default now(),
  primary key (tenant_id, runtime_kind, runtime_id, report_id),
  foreign key (tenant_id, runtime_kind, runtime_id)
    references genio_one_platform_runtime_registrations
      (tenant_id, runtime_kind, runtime_id)
    on delete restrict,
  foreign key (tenant_id, runtime_kind, runtime_id, command_id)
    references genio_one_platform_runtime_aggregate_commands
      (tenant_id, runtime_kind, runtime_id, command_id)
    on delete restrict,
  check (runtime_kind = 'GATEWAY'),
  check (length(trim(tenant_id)) > 0),
  check (length(trim(runtime_id)) > 0),
  check (length(trim(report_id)) > 0),
  check (length(trim(command_id)) > 0),
  check (length(trim(release_id)) > 0),
  check (package_digest ~ '^[a-f0-9]{64}$'),
  check (length(trim(revision)) > 0),
  check (digest ~ '^[a-f0-9]{64}$'),
  check (jsonb_typeof(report) = 'object'),
  check (outcome in ('ACCEPTED', 'STALE'))
);

create index if not exists genio_one_platform_runtime_aggregate_reports_idx
  on genio_one_platform_runtime_aggregate_report_history
    (tenant_id, runtime_kind, runtime_id, observed_at desc, report_id);
