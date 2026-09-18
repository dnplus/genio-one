create table if not exists genio_one_agent_delegation_revisions (
  tenant_id text not null,
  delegation_id text not null,
  revision integer not null,
  principal_subject_id text not null,
  agent_subject_id text not null,
  resource_id text not null,
  capability_ids text[] not null,
  acting_client_ids text[] not null,
  starts_at bigint not null,
  expires_at bigint not null,
  revocation_generation integer not null,
  state text not null,
  created_by_subject_id text not null,
  created_at bigint not null,
  primary key (tenant_id, delegation_id, revision),
  foreign key (tenant_id, principal_subject_id) references genio_one_subjects (tenant_id, subject_id),
  foreign key (tenant_id, agent_subject_id) references genio_one_subjects (tenant_id, subject_id),
  foreign key (tenant_id, resource_id) references genio_one_resources (tenant_id, resource_id),
  check (principal_subject_id <> agent_subject_id),
  check (cardinality(capability_ids) > 0),
  check (cardinality(acting_client_ids) > 0),
  check (expires_at > starts_at),
  check (revocation_generation >= 0),
  check (state in ('ACTIVE', 'REVOKED'))
);

create index if not exists genio_one_agent_delegation_agent_idx
  on genio_one_agent_delegation_revisions (tenant_id, agent_subject_id, state, expires_at);
