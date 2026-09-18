-- Integrity hardening for the normalized AI Gateway aggregates.
--
-- This migration intentionally fails closed when an existing database already
-- violates the new active-publication or route-reference invariants.  It must
-- not silently choose a revision or retire a live route during migration.

do $$
begin
  if exists (
    select 1
      from genio_one_publications
     where publication_state = 'PUBLISHED'
     group by tenant_id, resource_id
    having count(*) > 1
  ) then
    raise exception 'genio_one_publications contains multiple active revisions for a Resource';
  end if;
end
$$;

alter table genio_one_resource_connections
  add constraint genio_one_connections_provider_match_key
  unique (tenant_id, resource_id, connection_id, provider_profile_id);

alter table genio_one_public_models
  add constraint genio_one_models_resource_model_key
  unique (tenant_id, resource_id, model_id);

alter table genio_one_public_models
  add constraint genio_one_models_connection_provider_fk
  foreign key (tenant_id, resource_id, connection_id, provider_profile_id)
  references genio_one_resource_connections
    (tenant_id, resource_id, connection_id, provider_profile_id);

-- Exactly one published endpoint revision may serve a Resource.  Draft and
-- pending revisions may coexist with the active revision while being reviewed.
create unique index genio_one_publications_one_active_idx
  on genio_one_publications (tenant_id, resource_id)
  where publication_state = 'PUBLISHED';

alter table genio_one_publications
  add constraint genio_one_publications_projection_revision_key
  unique (tenant_id, publication_id, endpoint_revision, resource_revision);

-- A persisted projection must identify the exact publication snapshot it was
-- compiled from.  Existing rows are not guessed or backfilled: adding these
-- required fields fails closed until an explicit converter supplies them.
alter table genio_one_gateway_projections
  add column publication_id text not null,
  add column endpoint_revision bigint not null;

alter table genio_one_gateway_projections
  add constraint genio_one_gateway_projections_publication_fk
  foreign key (tenant_id, publication_id, endpoint_revision, resource_revision)
  references genio_one_publications
    (tenant_id, publication_id, endpoint_revision, resource_revision);

alter table genio_one_gateway_projections
  add constraint genio_one_gateway_projections_endpoint_revision_check
  check (endpoint_revision > 0);

-- Route transition records retain both sides of a model/Connection change.
-- The resource key makes the Connection references unambiguous.
alter table genio_one_model_route_transitions
  add column resource_id text not null;

alter table genio_one_model_route_transitions
  add constraint genio_one_route_transition_public_model_fk
  foreign key (tenant_id, resource_id, public_model_id)
  references genio_one_public_models (tenant_id, resource_id, model_id),
  add constraint genio_one_route_transition_from_model_fk
  foreign key (tenant_id, resource_id, from_model_id)
  references genio_one_public_models (tenant_id, resource_id, model_id),
  add constraint genio_one_route_transition_to_model_fk
  foreign key (tenant_id, resource_id, to_model_id)
  references genio_one_public_models (tenant_id, resource_id, model_id),
  add constraint genio_one_route_transition_from_connection_fk
  foreign key (tenant_id, resource_id, from_connection_id)
  references genio_one_resource_connections (tenant_id, resource_id, connection_id),
  add constraint genio_one_route_transition_to_connection_fk
  foreign key (tenant_id, resource_id, to_connection_id)
  references genio_one_resource_connections (tenant_id, resource_id, connection_id);

create index genio_one_projection_chain_resource_idx
  on genio_one_gateway_projections
    (tenant_id, resource_id, capability_id, policy_revision);
