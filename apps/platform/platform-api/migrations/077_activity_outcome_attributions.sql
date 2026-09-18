create table if not exists genio_one_activity_outcome_attributions (
  tenant_id text not null,
  attribution_id text not null,
  correlation_id text not null,
  source text not null,
  outcome_reference text not null,
  value text not null,
  observed_at bigint not null,
  recorded_by_subject_id text not null,
  recorded_at bigint not null,
  primary key (tenant_id, attribution_id),
  foreign key (tenant_id, correlation_id)
    references genio_one_gateway_activities (tenant_id, correlation_id),
  check (observed_at >= 0),
  check (recorded_at >= 0)
);

create index if not exists genio_one_activity_outcome_correlation_idx
  on genio_one_activity_outcome_attributions (tenant_id, correlation_id, observed_at, attribution_id);
