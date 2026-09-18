alter table genio_one_usage_policy_revisions
  add column if not exists display_name text;

update genio_one_usage_policy_revisions
   set display_name = usage_policy_id
 where display_name is null or length(trim(display_name)) = 0;

alter table genio_one_usage_policy_revisions
  add constraint genio_one_usage_policy_revisions_display_name_nonempty
  check (display_name is null or length(trim(display_name)) > 0);
