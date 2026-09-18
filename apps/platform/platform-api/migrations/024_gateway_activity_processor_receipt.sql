alter table genio_one_gateway_activities
  add column if not exists processor_bundle_revision text null,
  add column if not exists processor_request_steps jsonb not null default '[]'::jsonb,
  add column if not exists processor_response_steps jsonb not null default '[]'::jsonb;

alter table genio_one_gateway_activities
  drop constraint if exists genio_one_gateway_activities_processor_steps_check;

alter table genio_one_gateway_activities
  add constraint genio_one_gateway_activities_processor_steps_check check (
    jsonb_typeof(processor_request_steps) = 'array'
    and jsonb_typeof(processor_response_steps) = 'array'
  );
