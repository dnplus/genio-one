alter table genio_one_gateway_activities
  drop constraint if exists genio_one_gateway_activities_downstream_identity_mode_check;

alter table genio_one_gateway_activities
  add constraint genio_one_gateway_activities_downstream_identity_mode_check
  check (((downstream_identity_mode is null) or (downstream_identity_mode = any (array[
    'NONE'::text,
    'SERVICE'::text,
    'USER_PASSTHROUGH'::text,
    'USER_OAUTH'::text,
    'USER_PASSWORD'::text
  ]))));
