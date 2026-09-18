create table if not exists genio_one_organization_memberships (
  tenant_id text not null,
  organization_id text not null,
  subject_id text not null,
  role text not null default 'USER',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, organization_id, subject_id),
  foreign key (tenant_id, organization_id)
    references genio_one_organizations (tenant_id, organization_id)
    on delete cascade,
  foreign key (tenant_id, subject_id)
    references genio_one_subjects (tenant_id, subject_id)
    on delete cascade,
  check (role in ('USER', 'ORGANIZATION_ADMINISTRATOR'))
);

create table if not exists genio_one_organization_membership_sources (
  tenant_id text not null,
  organization_id text not null,
  kind text not null,
  reference text not null,
  status text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, organization_id, kind, reference),
  foreign key (tenant_id, organization_id)
    references genio_one_organizations (tenant_id, organization_id)
    on delete cascade,
  check (kind in ('MANUAL', 'SCIM_GROUP', 'OIDC_GROUP')),
  check (status in ('PENDING', 'SYNCED', 'ERROR')),
  check (length(trim(reference)) > 0)
);

create index if not exists genio_one_organization_memberships_subject_idx
  on genio_one_organization_memberships (tenant_id, subject_id, role);
