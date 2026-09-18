alter table genio_one_gateway_activities
  add column if not exists session_id text;

create index if not exists genio_one_gateway_activities_session_timeline_idx
  on genio_one_gateway_activities (tenant_id, session_id, occurred_at, correlation_id)
  where session_id is not null;
