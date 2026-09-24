lock table genio_one_distillation_markers in share row exclusive mode;

do $$
declare
  duplicate_count bigint;
begin
  select count(*)
    into duplicate_count
    from (
      select tenant_id, owner_subject_id, bot_id, thread_id, source_revision
        from genio_one_distillation_markers
        group by tenant_id, owner_subject_id, bot_id, thread_id, source_revision
        having count(*) > 1
    ) as duplicate_keys;
  if duplicate_count > 0 then
    raise exception 'Cannot add cross-version distillation marker uniqueness: % duplicate keys exist', duplicate_count;
  end if;
end $$;

alter table genio_one_distillation_markers
  add constraint genio_one_distillation_markers_cross_version_idempotency
  unique (tenant_id, owner_subject_id, bot_id, thread_id, source_revision);
