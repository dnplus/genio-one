create table if not exists genio_one_gateway_registrations (
  tenant_id text not null,
  runtime_id text not null,
  display_name text not null,
  gateway_id text not null,
  site_id text not null,
  region text not null,
  labels jsonb not null default '{}'::jsonb,
  identity_client_id text not null,
  state text not null,
  registered_by_subject_id text not null,
  registered_at timestamptz not null default now(),
  activated_at timestamptz,
  retired_at timestamptz,
  row_revision bigint not null default 1,
  primary key (tenant_id, runtime_id),
  foreign key (tenant_id, registered_by_subject_id)
    references genio_one_subjects (tenant_id, subject_id),
  check (length(trim(display_name)) > 0),
  check (length(trim(gateway_id)) > 0),
  check (length(trim(site_id)) > 0),
  check (length(trim(region)) > 0),
  check (jsonb_typeof(labels) = 'object'),
  check (state in ('PROVISIONING', 'ACTIVE', 'RETIRED')),
  check (row_revision > 0)
);

create index if not exists genio_one_gateway_registrations_state_idx
  on genio_one_gateway_registrations (tenant_id, state, registered_at desc);
