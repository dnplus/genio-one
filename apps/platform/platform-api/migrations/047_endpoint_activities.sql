create table if not exists genio_one_endpoint_activities (
  tenant_id text not null,
  activity_id text not null,
  correlation_id text not null,
  kind text not null,
  subject_id text not null,
  device_id text not null,
  destination_host text not null,
  resource_id text not null,
  resource_class text not null,
  client_status text not null,
  acting_client_id text,
  route text not null,
  routing_policy_rule_id text,
  applied_state_revision text not null,
  applied_policy_version text not null,
  request_count bigint not null,
  bytes_sent bigint not null,
  bytes_received bigint not null,
  observed_at bigint not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, activity_id),
  unique (tenant_id, device_id, correlation_id),
  check (kind in ('DISCOVERY', 'USAGE')),
  check (resource_class in ('KNOWN', 'UNCLASSIFIED')),
  check (client_status in ('UNKNOWN', 'VERIFIED')),
  check ((client_status = 'UNKNOWN' and acting_client_id is null) or (client_status = 'VERIFIED' and length(trim(acting_client_id)) > 0)),
  check (route in ('DIRECT', 'MANAGED', 'BLOCK')),
  check (request_count > 0),
  check (bytes_sent >= 0),
  check (bytes_received >= 0),
  check (observed_at >= 0)
);

create index if not exists genio_one_endpoint_activities_recent_idx
  on genio_one_endpoint_activities (tenant_id, observed_at desc, activity_id desc);

create index if not exists genio_one_endpoint_activities_resource_idx
  on genio_one_endpoint_activities (tenant_id, resource_id, observed_at asc);
