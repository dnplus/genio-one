alter table genio_one_gateway_activities
  add column if not exists route_mode text,
  add column if not exists route_lease_id text,
  add column if not exists route_lease_reused boolean,
  add column if not exists routing_policy_id text,
  add column if not exists routing_revision bigint,
  add column if not exists candidate_set_digest text;

alter table genio_one_gateway_activities
  drop constraint if exists genio_one_gateway_activities_routing_evidence_check;

alter table genio_one_gateway_activities
  add constraint genio_one_gateway_activities_routing_evidence_check check (
    (route_mode is null or route_mode in ('DETERMINISTIC', 'SESSION_LEASE')) and
    (routing_revision is null or routing_revision >= 1) and
    (candidate_set_digest is null or candidate_set_digest ~ '^[a-f0-9]{64}$') and
    (
      route_mode <> 'SESSION_LEASE' or
      (route_lease_id is not null and route_lease_reused is not null and
       routing_policy_id is not null and routing_revision is not null and
       candidate_set_digest is not null)
    )
  );
