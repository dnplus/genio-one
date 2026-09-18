create table if not exists genio_one_execution_grant_request_revisions (
  tenant_id text not null,
  request_id text not null,
  revision integer not null,
  subject_id text not null,
  acting_client_id text not null,
  resource_id text not null,
  capability_id text not null,
  action_digest text not null,
  requested_expires_at bigint not null,
  state text not null,
  created_by_subject_id text not null,
  created_at bigint not null,
  decided_by_subject_id text,
  decided_at bigint,
  decision_reason text,
  execution_grant_id text,
  primary key (tenant_id, request_id, revision),
  foreign key (tenant_id, subject_id) references genio_one_subjects (tenant_id, subject_id),
  foreign key (tenant_id, resource_id) references genio_one_resources (tenant_id, resource_id),
  check (revision > 0),
  check (action_digest ~ '^[a-f0-9]{64}$'),
  check (requested_expires_at > created_at),
  check (state in ('PENDING', 'APPROVED', 'DENIED'))
);

create table if not exists genio_one_execution_grants (
  tenant_id text not null,
  execution_grant_id text not null,
  request_id text not null,
  subject_id text not null,
  acting_client_id text not null,
  resource_id text not null,
  capability_id text not null,
  action_digest text not null,
  issued_at bigint not null,
  expires_at bigint not null,
  issued_by_subject_id text not null,
  primary key (tenant_id, execution_grant_id),
  unique (tenant_id, request_id),
  foreign key (tenant_id, subject_id) references genio_one_subjects (tenant_id, subject_id),
  foreign key (tenant_id, resource_id) references genio_one_resources (tenant_id, resource_id),
  check (action_digest ~ '^[a-f0-9]{64}$'),
  check (expires_at > issued_at)
);

create index if not exists genio_one_execution_grants_subject_idx
  on genio_one_execution_grants (tenant_id, subject_id, resource_id, capability_id, expires_at);
