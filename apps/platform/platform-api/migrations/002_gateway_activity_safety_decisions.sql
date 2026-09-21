alter table genio_one_gateway_activities
  add column if not exists safety_decisions jsonb not null default '[]'::jsonb;

alter table genio_one_gateway_activities
  drop constraint if exists genio_one_gateway_activities_safety_decisions_check;

alter table genio_one_gateway_activities
  add constraint genio_one_gateway_activities_safety_decisions_check
  check (jsonb_typeof(safety_decisions) = 'array');
