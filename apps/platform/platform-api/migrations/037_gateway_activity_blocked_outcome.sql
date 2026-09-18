alter table genio_one_gateway_activities
  drop constraint if exists genio_one_gateway_activities_outcome_check;

alter table genio_one_gateway_activities
  add constraint genio_one_gateway_activities_outcome_check
  check (outcome in (
    'COMPLETED',
    'RATE_LIMITED',
    'UNAUTHENTICATED',
    'DENIED',
    'BLOCKED',
    'FAILED'
  ));
