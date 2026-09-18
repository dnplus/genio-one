create table if not exists genio_one_gateway_authorization_audit_events (
  tenant_id text not null,
  audit_event_id text not null,
  correlation_id text not null,
  occurred_at bigint not null,
  event jsonb not null,
  primary key (tenant_id, audit_event_id),
  check (occurred_at >= 0)
);

create index if not exists genio_one_gateway_authorization_audit_recent_idx
  on genio_one_gateway_authorization_audit_events (tenant_id, occurred_at desc);

create index if not exists genio_one_gateway_authorization_audit_correlation_idx
  on genio_one_gateway_authorization_audit_events (tenant_id, correlation_id);
