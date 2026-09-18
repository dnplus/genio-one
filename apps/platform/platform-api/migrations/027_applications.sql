create table if not exists genio_one_applications (
  tenant_id text not null,
  application_id text not null,
  subject_id text not null,
  display_name text not null,
  owner_organization_id text not null,
  registered_by_subject_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, application_id),
  unique (tenant_id, subject_id),
  foreign key (tenant_id, subject_id)
    references genio_one_subjects (tenant_id, subject_id),
  foreign key (tenant_id, owner_organization_id)
    references genio_one_organizations (tenant_id, organization_id),
  foreign key (tenant_id, registered_by_subject_id)
    references genio_one_subjects (tenant_id, subject_id),
  check (length(trim(display_name)) > 0)
);

create index if not exists genio_one_applications_owner_idx
  on genio_one_applications (tenant_id, owner_organization_id, created_at desc);
