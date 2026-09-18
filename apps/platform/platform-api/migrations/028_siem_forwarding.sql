create table if not exists genio_one_siem_destinations (
  tenant_id text primary key,
  destination_id text not null,
  endpoint_url text not null,
  event_kinds jsonb not null default '[]'::jsonb,
  enabled boolean not null default true,
  configured_by_subject_id text not null,
  configured_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, configured_by_subject_id)
    references genio_one_subjects (tenant_id, subject_id),
  check (jsonb_typeof(event_kinds) = 'array'),
  check (length(trim(destination_id)) > 0),
  check (length(trim(endpoint_url)) > 0)
);

create table if not exists genio_one_siem_deliveries (
  tenant_id text not null,
  destination_id text not null,
  audit_event_id text not null,
  endpoint_url text not null,
  event jsonb not null,
  status text not null default 'PENDING',
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_owner text,
  lease_expires_at timestamptz,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, destination_id, audit_event_id),
  check (status in ('PENDING', 'IN_FLIGHT', 'RETRY_SCHEDULED', 'DELIVERED', 'CANCELLED')),
  check (attempt_count >= 0),
  check (jsonb_typeof(event) = 'object')
);

create index if not exists genio_one_siem_delivery_due_idx
  on genio_one_siem_deliveries (status, next_attempt_at);
