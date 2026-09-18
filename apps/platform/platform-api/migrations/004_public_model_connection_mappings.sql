-- Public Model aliases are stable tenant-scoped client-facing names.  Provider-specific
-- model names belong to a mapping from an alias to one Resource-owned
-- Connection.  This migration intentionally refuses to guess how the old
-- one-model/one-connection rows should be split.

do $$
begin
  if exists (select 1 from genio_one_public_models limit 1) then
    raise exception
      'genio_one_public_models contains legacy rows; run an explicit PublicModel/ConnectionModelMapping converter before migration 004';
  end if;
  if exists (select 1 from genio_one_model_route_transitions limit 1) then
    raise exception
      'genio_one_model_route_transitions contains legacy rows; run an explicit mapping-aware converter before migration 004';
  end if;
end
$$;

alter table genio_one_public_models
  drop constraint if exists genio_one_models_connection_provider_fk,
  drop constraint if exists genio_one_public_models_tenant_id_resource_id_model_name_key;

alter table genio_one_public_models
  drop column connection_id,
  drop column provider_profile_id;

alter table genio_one_public_models
  add constraint genio_one_models_public_name_key
  unique (tenant_id, model_name),
  add constraint genio_one_models_resource_fk
  foreign key (tenant_id, resource_id)
  references genio_one_resources (tenant_id, resource_id);

create table if not exists genio_one_connection_model_mappings (
  tenant_id text not null,
  mapping_id text not null,
  public_model_id text not null,
  resource_id text not null,
  connection_id text not null,
  provider_model text not null,
  mapping_revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, mapping_id),
  unique (tenant_id, resource_id, mapping_id),
  unique (tenant_id, resource_id, public_model_id, connection_id),
  foreign key (tenant_id, resource_id, public_model_id)
    references genio_one_public_models (tenant_id, resource_id, model_id),
  foreign key (tenant_id, resource_id, connection_id)
    references genio_one_resource_connections (tenant_id, resource_id, connection_id),
  check (mapping_revision > 0),
  check (length(trim(provider_model)) > 0)
);

create index if not exists genio_one_model_mappings_model_idx
  on genio_one_connection_model_mappings
    (tenant_id, resource_id, public_model_id, mapping_revision);

-- A route transition records the concrete mapping revision selected for each
-- side of a model change. Existing rows are rejected above because their
-- connection-only records cannot be assigned to a mapping without guessing.
alter table genio_one_model_route_transitions
  add column from_mapping_id text,
  add column to_mapping_id text not null,
  add column from_provider_model text,
  add column to_provider_model text not null,
  add column from_mapping_revision bigint,
  add column to_mapping_revision bigint not null;

alter table genio_one_model_route_transitions
  add constraint genio_one_route_transition_from_mapping_fk
  foreign key (tenant_id, resource_id, from_mapping_id)
  references genio_one_connection_model_mappings (tenant_id, resource_id, mapping_id),
  add constraint genio_one_route_transition_to_mapping_fk
  foreign key (tenant_id, resource_id, to_mapping_id)
  references genio_one_connection_model_mappings (tenant_id, resource_id, mapping_id),
  add constraint genio_one_route_transition_mapping_revision_check
  check (
    to_mapping_revision > 0 and
    (from_mapping_revision is null or from_mapping_revision > 0)
  );
