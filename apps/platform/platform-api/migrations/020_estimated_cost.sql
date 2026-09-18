create table if not exists genio_one_price_catalog_versions (
  source text not null,
  source_version text not null,
  source_url text not null,
  fetched_at bigint not null check (fetched_at >= 0),
  status text not null check (status in ('CURRENT', 'LKG')),
  primary key (source, source_version),
  check (source_version ~ '^[a-f0-9]{64}$')
);

create unique index if not exists genio_one_price_catalog_one_current
  on genio_one_price_catalog_versions (source)
  where status = 'CURRENT';

create table if not exists genio_one_model_price_catalog (
  source text not null,
  source_version text not null,
  provider_id text not null,
  catalog_model_key text not null,
  provider_model_id text not null,
  input_cost_per_token numeric(30,18) not null check (input_cost_per_token >= 0),
  output_cost_per_token numeric(30,18) not null check (output_cost_per_token >= 0),
  fetched_at bigint not null check (fetched_at >= 0),
  primary key (source, source_version, provider_id, catalog_model_key),
  foreign key (source, source_version)
    references genio_one_price_catalog_versions (source, source_version)
    on delete cascade
);

create index if not exists genio_one_model_price_lookup
  on genio_one_model_price_catalog (source, source_version, provider_id, provider_model_id);

alter table genio_one_gateway_activities
  add column if not exists cost_estimation_status text not null default 'NOT_APPLICABLE',
  add column if not exists estimated_cost_currency text,
  add column if not exists estimated_cost_micros bigint,
  add column if not exists pricing_source text,
  add column if not exists pricing_version text;

alter table genio_one_gateway_activities
  drop constraint if exists genio_one_gateway_activities_estimated_cost_check;

alter table genio_one_gateway_activities
  add constraint genio_one_gateway_activities_estimated_cost_check check (
    cost_estimation_status in ('ESTIMATED', 'UNPRICED', 'NOT_APPLICABLE') and
    (estimated_cost_micros is null or estimated_cost_micros >= 0) and
    (
      (cost_estimation_status = 'ESTIMATED' and estimated_cost_currency is not null and estimated_cost_micros is not null and pricing_source is not null and pricing_version is not null) or
      (cost_estimation_status <> 'ESTIMATED' and estimated_cost_currency is null and estimated_cost_micros is null)
    )
  );
