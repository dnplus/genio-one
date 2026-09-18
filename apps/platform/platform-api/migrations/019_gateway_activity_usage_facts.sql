alter table genio_one_gateway_activities
  add column if not exists requested_model_id text,
  add column if not exists effective_model_id text,
  add column if not exists provider_id text,
  add column if not exists connection_id text,
  add column if not exists input_tokens bigint,
  add column if not exists output_tokens bigint,
  add column if not exists total_tokens bigint;

alter table genio_one_gateway_activities
  drop constraint if exists genio_one_gateway_activities_usage_facts_check;

alter table genio_one_gateway_activities
  add constraint genio_one_gateway_activities_usage_facts_check check (
    (input_tokens is null or input_tokens >= 0) and
    (output_tokens is null or output_tokens >= 0) and
    (total_tokens is null or total_tokens >= 0)
  );
