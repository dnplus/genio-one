update genio_one_gateway_authorization_audit_events
   set event = (event #>> '{}')::jsonb
 where jsonb_typeof(event) = 'string';

alter table genio_one_gateway_authorization_audit_events
  add constraint genio_one_gateway_authorization_audit_events_object_check
  check (jsonb_typeof(event) = 'object');
