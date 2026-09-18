alter table genio_one_model_routing_policies
  add column if not exists context_requirements jsonb not null default '[]'::jsonb;

alter table genio_one_model_routing_policies
  drop constraint if exists genio_one_model_routing_context_requirements_check;

alter table genio_one_model_routing_policies
  add constraint genio_one_model_routing_context_requirements_check
  check (jsonb_typeof(context_requirements) = 'array');
