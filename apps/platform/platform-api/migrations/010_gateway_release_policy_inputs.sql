-- Aggregate Gateway release publication resolves one closed projection set,
-- then freezes all policy inputs in the same transaction. These indexes match
-- those release-oriented lookup paths rather than end-user catalog queries.

create index if not exists genio_one_publications_gateway_state_idx
  on genio_one_publications
    (tenant_id, gateway_id, publication_state, publication_id);

create index if not exists genio_one_gateway_projections_publication_revision_idx
  on genio_one_gateway_projections
    (tenant_id, publication_id, endpoint_revision, resource_revision, projection_id);

create index if not exists genio_one_model_entitlements_model_idx
  on genio_one_model_entitlements
    (tenant_id, public_model_id, state, starts_at, expires_at, entitlement_id);
