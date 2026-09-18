alter table genio_one_resource_connections
  add column if not exists configuration_revision bigint not null default 1,
  add column if not exists lifecycle text,
  add column if not exists verification_state text,
  add column if not exists health_state text,
  add column if not exists health_observed_at timestamptz,
  add column if not exists health_source_revision bigint,
  add column if not exists routing_priority integer not null default 0,
  add column if not exists region text,
  add column if not exists supported_obligations text[] not null default '{}';

update genio_one_resource_connections
set lifecycle = case status
      when 'DISABLED' then 'DISABLED'
      when 'DRAFT' then 'DRAFT'
      else 'ENABLED'
    end,
    verification_state = case
      when status in ('READY', 'DEGRADED') then 'VERIFIED'
      else 'UNVERIFIED'
    end,
    health_state = case status
      when 'READY' then 'HEALTHY'
      when 'DEGRADED' then 'DEGRADED'
      else 'UNKNOWN'
    end
where lifecycle is null or verification_state is null or health_state is null;

alter table genio_one_resource_connections
  alter column lifecycle set not null,
  alter column verification_state set not null,
  alter column health_state set not null,
  add constraint genio_one_resource_connections_configuration_revision_positive check (configuration_revision > 0),
  add constraint genio_one_resource_connections_lifecycle check (lifecycle in ('DRAFT', 'ENABLED', 'DISABLED', 'REVOKE_PENDING', 'REVOKED')),
  add constraint genio_one_resource_connections_verification_state check (verification_state in ('UNVERIFIED', 'VERIFIED', 'FAILED')),
  add constraint genio_one_resource_connections_health_state check (health_state in ('UNKNOWN', 'HEALTHY', 'DEGRADED', 'UNAVAILABLE')),
  add constraint genio_one_resource_connections_health_revision_positive check (health_source_revision is null or health_source_revision > 0),
  add constraint genio_one_resource_connections_routing_priority_range check (routing_priority between 0 and 1000),
  add constraint genio_one_resource_connections_region_nonempty check (region is null or length(trim(region)) > 0);
