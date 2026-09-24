lock table genio_one_distillation_markers in share row exclusive mode;

alter table genio_one_distillation_markers
  add column workspace_acl_version integer not null default 0;

update genio_one_distillation_markers
  set workspace_acl_version = 1
  where workspace_id is not null;

alter table genio_one_distillation_markers
  add constraint genio_one_distillation_markers_workspace_acl_check
  check (workspace_id is null or workspace_acl_version = 1);
