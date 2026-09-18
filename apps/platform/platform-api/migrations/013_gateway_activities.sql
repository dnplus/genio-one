create table if not exists genio_one_gateway_activities (
  tenant_id text not null,
  correlation_id text not null,
  resource_id text not null,
  capability_id text,
  application_id text,
  subject_id text,
  acting_client_id text,
  entitlement_id text,
  enforcement_point_id text not null,
  route text not null,
  method text not null,
  path text not null,
  status_code integer not null,
  outcome text not null,
  error_code text,
  latency_millis bigint,
  upstream_attempted boolean not null,
  detail_availability text not null,
  detail_ref text,
  detail_expires_at bigint,
  occurred_at bigint not null,
  primary key (tenant_id, correlation_id),
  foreign key (tenant_id, resource_id)
    references genio_one_resources (tenant_id, resource_id),
  check (route = 'MANAGED'),
  check (status_code between 100 and 599),
  check (outcome in ('COMPLETED','RATE_LIMITED','UNAUTHENTICATED','DENIED','FAILED')),
  check (detail_availability in ('AVAILABLE','EXPIRED','NOT_CAPTURED')),
  check (latency_millis is null or latency_millis >= 0),
  check (occurred_at >= 0)
);

create index if not exists genio_one_gateway_activities_recent_idx
  on genio_one_gateway_activities (tenant_id, occurred_at desc);
