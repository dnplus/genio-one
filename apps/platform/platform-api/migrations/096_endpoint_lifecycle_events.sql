create table genio_one_endpoint_lifecycle_events (
  event_id bigint generated always as identity primary key,
  tenant_id text not null,
  device_id text not null,
  subject_id text not null,
  correlation_id text not null,
  kind text not null check (kind in ('ENROLLED', 'REVOKED')),
  reason text,
  at bigint not null check (at >= 0),
  foreign key (tenant_id, device_id) references genio_one_endpoint_devices (tenant_id, device_id),
  unique (tenant_id, device_id, kind),
  check ((kind = 'ENROLLED' and reason is null) or (kind = 'REVOKED' and length(trim(reason)) > 0))
);

create index genio_one_endpoint_lifecycle_events_device_idx
  on genio_one_endpoint_lifecycle_events (tenant_id, device_id, event_id);
