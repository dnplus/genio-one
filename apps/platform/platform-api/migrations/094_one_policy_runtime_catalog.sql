create table if not exists genio_one_policy_revisions (
  tenant_id text not null,
  policy_id text not null,
  revision bigint not null,
  display_name text not null,
  provenance text not null,
  enabled boolean not null default true,
  scope jsonb not null,
  rules jsonb not null,
  published_by_subject_id text,
  created_at timestamptz not null default now(),
  published_at timestamptz not null default now(),
  primary key (tenant_id, policy_id, revision),
  check (revision > 0),
  check (provenance in ('SYSTEM_SEED', 'TENANT_AUTHORED')),
  check (jsonb_typeof(scope) = 'object'),
  check (jsonb_typeof(rules) = 'array')
);

create index if not exists genio_one_policy_revisions_latest_idx
  on genio_one_policy_revisions (tenant_id, policy_id, revision desc);

create index if not exists genio_one_policy_revisions_scope_idx
  on genio_one_policy_revisions using gin (scope);
