alter table genio_one_gateway_activities
  add column if not exists usage_admission_id text,
  add column if not exists usage_admission_disposition text not null default 'NOT_APPLICABLE',
  add column if not exists usage_admission_reason text,
  add column if not exists consumer_organization_id text,
  add column if not exists resource_owner_organization_id text,
  add column if not exists use_case_id text;

alter table genio_one_gateway_activities
  drop constraint if exists genio_one_gateway_activities_usage_admission_disposition_check,
  add constraint genio_one_gateway_activities_usage_admission_disposition_check
    check (usage_admission_disposition in ('ADMIT', 'REJECT', 'NOT_APPLICABLE')),
  drop constraint if exists genio_one_gateway_activities_usage_admission_reason_check,
  add constraint genio_one_gateway_activities_usage_admission_reason_check
    check (usage_admission_reason is null or usage_admission_reason in (
      'QUOTA_EXHAUSTED',
      'CONCURRENCY_EXHAUSTED',
      'CREDIT_EXHAUSTED',
      'COST_BUDGET_EXHAUSTED',
      'UNPRICED_USAGE',
      'STORE_UNAVAILABLE'
    ));
