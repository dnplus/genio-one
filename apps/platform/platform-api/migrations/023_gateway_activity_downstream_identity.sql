alter table genio_one_gateway_activities
  add column if not exists downstream_identity_mode text null;

alter table genio_one_gateway_activities
  drop constraint if exists genio_one_gateway_activities_downstream_identity_mode_check;

alter table genio_one_gateway_activities
  add constraint genio_one_gateway_activities_downstream_identity_mode_check
  check (
    downstream_identity_mode is null
    or downstream_identity_mode in ('NONE', 'SERVICE', 'USER_PASSTHROUGH')
  );
