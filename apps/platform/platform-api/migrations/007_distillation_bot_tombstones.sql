create table genio_one_distillation_bot_tombstones (
  tenant_id text not null,
  owner_subject_id text not null,
  bot_id text not null,
  deleted_at bigint not null,
  constraint genio_one_distillation_bot_tombstones_pkey primary key (tenant_id, owner_subject_id, bot_id)
);
