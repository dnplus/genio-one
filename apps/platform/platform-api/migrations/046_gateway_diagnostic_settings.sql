create table if not exists genio_one_gateway_diagnostic_settings (
  tenant_id text not null,
  gateway_id text not null,
  capture_message_content boolean not null default false,
  updated_by_subject_id text not null,
  row_revision bigint not null default 1 check (row_revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, gateway_id),
  foreign key (tenant_id, updated_by_subject_id)
    references genio_one_subjects (tenant_id, subject_id)
);
