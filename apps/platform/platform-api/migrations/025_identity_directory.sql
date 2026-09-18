create table if not exists genio_one_subjects (
  tenant_id text not null,
  subject_id text not null,
  kind text not null,
  display_name text,
  email text,
  department text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, subject_id),
  check (length(trim(tenant_id)) > 0),
  check (length(trim(subject_id)) > 0),
  check (kind in ('PERSON', 'APPLICATION', 'AGENT')),
  check (display_name is null or length(trim(display_name)) > 0),
  check (email is null or length(trim(email)) > 0),
  check (department is null or length(trim(department)) > 0)
);

create table if not exists genio_one_subject_roles (
  tenant_id text not null,
  subject_id text not null,
  role text not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, subject_id, role),
  foreign key (tenant_id, subject_id)
    references genio_one_subjects (tenant_id, subject_id)
    on delete cascade,
  check (role in ('USER', 'TENANT_ADMINISTRATOR'))
);

create table if not exists genio_one_external_identity_bindings (
  tenant_id text not null,
  provider_id text not null,
  external_subject_id text not null,
  subject_id text not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, provider_id, external_subject_id),
  foreign key (tenant_id, subject_id)
    references genio_one_subjects (tenant_id, subject_id)
    on delete cascade,
  check (length(trim(provider_id)) > 0),
  check (length(trim(external_subject_id)) > 0)
);
