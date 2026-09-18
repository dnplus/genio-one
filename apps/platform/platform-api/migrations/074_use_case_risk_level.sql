alter table genio_one_use_cases
  add column if not exists risk_level text not null default 'LOW';

alter table genio_one_use_cases
  drop constraint if exists genio_one_use_cases_risk_level_check;

alter table genio_one_use_cases
  add constraint genio_one_use_cases_risk_level_check
  check (risk_level in ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL'));
