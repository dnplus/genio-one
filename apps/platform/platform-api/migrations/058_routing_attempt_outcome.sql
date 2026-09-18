alter table genio_one_routing_attempt_events
  drop constraint genio_one_routing_attempt_events_outcome_check;

alter table genio_one_routing_attempt_events
  add constraint genio_one_routing_attempt_events_outcome_check
  check (outcome in (
    'SELECTED',
    'CONNECT_FAILURE',
    'RESET_BEFORE_RESPONSE',
    'RETRIED_BEFORE_RESPONSE',
    'HTTP_5XX',
    'MID_STREAM_FAILURE'
  ));
