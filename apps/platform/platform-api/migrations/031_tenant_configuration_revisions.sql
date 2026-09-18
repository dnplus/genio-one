create table if not exists genio_one_tenant_configuration_revisions (
  tenant_id text not null,
  revision text not null,
  state text not null,
  settings jsonb not null,
  created_by_subject_id text not null,
  created_at timestamptz not null default now(),
  validated_at timestamptz,
  previewed_at timestamptz,
  reviewed_at timestamptz,
  published_at timestamptz,
  observed_revision text,
  projection_status text not null default 'PENDING',
  projection_drift boolean not null default true,
  projection_last_error text,
  projection_retry_count integer not null default 0,
  projection_last_reconciled_at timestamptz,
  rolled_back_from text,
  primary key (tenant_id, revision),
  foreign key (tenant_id, created_by_subject_id)
    references genio_one_subjects (tenant_id, subject_id),
  check (state in ('DRAFT', 'VALIDATED', 'REVIEWED', 'PUBLISHED')),
  check (jsonb_typeof(settings) = 'object'),
  check (projection_status in ('PENDING', 'CONVERGED', 'FAILED', 'ROLLED_BACK')),
  check (projection_retry_count >= 0)
);

create index if not exists genio_one_tenant_configuration_revisions_latest_idx
  on genio_one_tenant_configuration_revisions (tenant_id, created_at desc, revision desc);
