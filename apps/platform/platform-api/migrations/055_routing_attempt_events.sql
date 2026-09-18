create table if not exists genio_one_routing_attempt_events (
  tenant_id text not null,
  correlation_id text not null,
  attempt_id text not null,
  attempt_order integer not null,
  connection_id text not null,
  connection_configuration_revision bigint not null,
  priority integer not null,
  outcome text not null,
  response_started boolean not null,
  occurred_at timestamptz not null,
  primary key (tenant_id, correlation_id, attempt_id),
  unique (tenant_id, correlation_id, attempt_order),
  check (attempt_order > 0),
  check (connection_configuration_revision > 0),
  check (priority between 0 and 1000),
  check (outcome in ('SELECTED', 'CONNECT_FAILURE', 'RESET_BEFORE_RESPONSE', 'HTTP_5XX', 'MID_STREAM_FAILURE'))
);

alter table genio_one_gateway_activities
  add column if not exists candidate_connection_ids text[] not null default '{}',
  add column if not exists release_id text,
  add column if not exists release_head_revision bigint;
