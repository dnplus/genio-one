create table if not exists genio_one_endpoint_devices (
  tenant_id text not null,
  device_id text not null,
  subject_id text not null,
  lifecycle_state text not null,
  enrolled_at bigint not null,
  last_seen_at bigint not null,
  endpoint_version text not null,
  applied_state_revision text,
  applied_policy_version text,
  health text not null,
  reported_at bigint not null,
  revocation_reason text,
  primary key (tenant_id, device_id),
  check (lifecycle_state in ('ACTIVE', 'REVOKED')),
  check (health in ('UNKNOWN', 'HEALTHY', 'DEGRADED')),
  check ((applied_state_revision is null) = (applied_policy_version is null)),
  check (enrolled_at >= 0),
  check (last_seen_at >= enrolled_at),
  check (reported_at >= enrolled_at),
  check ((lifecycle_state = 'ACTIVE' and revocation_reason is null) or (lifecycle_state = 'REVOKED' and length(trim(revocation_reason)) > 0))
);

create index if not exists genio_one_endpoint_devices_subject_idx
  on genio_one_endpoint_devices (tenant_id, subject_id, last_seen_at desc);
