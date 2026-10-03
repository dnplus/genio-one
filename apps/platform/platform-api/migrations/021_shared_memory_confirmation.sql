alter table genio_one_shared_memories
  add column confirmed_at bigint,
  add constraint genio_one_shared_memories_confirmation_check
  check (confirmed_at is null or (
    scope in ('TEAM', 'ORGANIZATION')
    and confirmed_at >= created_at
    and confirmed_at = updated_at
  ));

alter table genio_one_shared_memory_mutations
  add column reviewer_subject_id text,
  add column reviewer_client_id text,
  add column reviewed_at bigint,
  add constraint genio_one_shared_memory_mutations_confirmation_check
  check ((reviewer_subject_id is null and reviewer_client_id is null and reviewed_at is null)
    or (reviewer_subject_id is not null and reviewer_client_id is not null and reviewed_at is not null
      and length(reviewer_subject_id) between 1 and 256
      and length(trim(reviewer_subject_id)) > 0
      and length(reviewer_client_id) between 1 and 256
      and length(trim(reviewer_client_id)) > 0
      and scope in ('TEAM', 'ORGANIZATION')
      and operation = 'REPLACED'
      and reviewed_at = occurred_at));
