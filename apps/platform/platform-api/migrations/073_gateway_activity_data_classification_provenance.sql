alter table genio_one_gateway_activities
  add column if not exists data_classifications jsonb not null default '[]'::jsonb;

alter table genio_one_gateway_activities
  drop constraint if exists genio_one_gateway_activities_data_classifications_check;

alter table genio_one_gateway_activities
  add constraint genio_one_gateway_activities_data_classifications_check
  check (jsonb_typeof(data_classifications) = 'array');
