create function genio_one_migration_080_canonical_json(value jsonb)
returns text
language plpgsql
immutable
strict
as $$
declare
  result text;
begin
  if jsonb_typeof(value) = 'object' then
    select '{' || coalesce(string_agg(to_jsonb(key)::text || ':' || genio_one_migration_080_canonical_json(value -> key), ',' order by key), '') || '}'
      into result
      from jsonb_object_keys(value) as key;
    return result;
  end if;
  if jsonb_typeof(value) = 'array' then
    select '[' || coalesce(string_agg(genio_one_migration_080_canonical_json(item), ',' order by position), '') || ']'
      into result
      from jsonb_array_elements(value) with ordinality as element(item, position);
    return result;
  end if;
  return value::text;
end;
$$;

with legacy as (
  select
    connection.tenant_id,
    connection.connection_id,
    resource.owner_organization_id,
    connection.display_name,
    'provider-credential-migrated-' || substr(encode(sha256(convert_to(connection.tenant_id || ':' || connection.connection_id, 'UTF8')), 'hex'), 1, 32) as profile_id,
    case
      when connection.downstream_identity ->> 'authentication' = 'GCP_WORKLOAD_IDENTITY' then 'GCP'
      else 'GENERIC'
    end as adapter_family,
    case
      when connection.downstream_identity ->> 'authentication' = 'GCP_WORKLOAD_IDENTITY' then
        jsonb_strip_nulls(jsonb_build_object(
          'kind', 'OIDC_FEDERATION',
          'source', jsonb_build_object(
            'issuer', connection.downstream_identity #>> '{gcp_workload_identity,oidc_issuer}',
            'client_id', connection.downstream_identity #>> '{gcp_workload_identity,oidc_client_id}',
            'client_secret_ref', connection.credential_ref,
            'audience', connection.downstream_identity #>> '{gcp_workload_identity,oidc_audience}'
          ),
          'exchange', jsonb_build_object(
            'adapter', 'GCP_STS',
            'project_name', connection.downstream_identity #>> '{gcp_workload_identity,project_name}',
            'region', connection.downstream_identity #>> '{gcp_workload_identity,region}',
            'project_id', connection.downstream_identity #>> '{gcp_workload_identity,project_id}',
            'workload_identity_pool_name', connection.downstream_identity #>> '{gcp_workload_identity,workload_identity_pool_name}',
            'workload_identity_provider_name', connection.downstream_identity #>> '{gcp_workload_identity,workload_identity_provider_name}',
            'service_account_name', connection.downstream_identity #>> '{gcp_workload_identity,service_account_name}'
          )
        ))
      else jsonb_build_object('kind', 'STATIC_SECRET_REFERENCE', 'secret_ref', connection.credential_ref)
    end as strategy
  from genio_one_resource_connections connection
  join genio_one_resources resource
    on resource.tenant_id = connection.tenant_id
   and resource.resource_id = connection.resource_id
  where connection.connection_kind = 'LLM'
    and (
      connection.downstream_identity ->> 'authentication' = 'GCP_WORKLOAD_IDENTITY'
      or (connection.downstream_identity = '{"mode":"NONE"}'::jsonb and connection.credential_ref is not null)
    )
)
insert into genio_one_provider_credential_profile_revisions
  (tenant_id, profile_id, revision, owner_organization_id, display_name,
   adapter_family, strategy, strategy_digest, state, created_by_subject_id)
select
  tenant_id,
  profile_id,
  1,
  owner_organization_id,
  display_name || ' credential',
  adapter_family,
  strategy,
  encode(sha256(convert_to(genio_one_migration_080_canonical_json(strategy), 'UTF8')), 'hex'),
  'ACTIVE',
  'system-migration-080'
from legacy
on conflict (tenant_id, profile_id, revision) do nothing;

with legacy as (
  select
    connection.tenant_id,
    connection.resource_id,
    connection.connection_id,
    'provider-credential-migrated-' || substr(encode(sha256(convert_to(connection.tenant_id || ':' || connection.connection_id, 'UTF8')), 'hex'), 1, 32) as profile_id
  from genio_one_resource_connections connection
  where connection.connection_kind = 'LLM'
    and (
      connection.downstream_identity ->> 'authentication' = 'GCP_WORKLOAD_IDENTITY'
      or (connection.downstream_identity = '{"mode":"NONE"}'::jsonb and connection.credential_ref is not null)
    )
)
update genio_one_resource_connections connection
   set provider_credential_profile_id = legacy.profile_id,
       provider_credential_profile_revision = profile.revision,
       provider_credential_strategy_digest = profile.strategy_digest,
       downstream_identity = '{"mode":"SERVICE","authentication":"PROVIDER_CREDENTIAL_PROFILE"}'::jsonb,
       credential_ref = null,
       configuration_revision = connection.configuration_revision + 1,
       verification_state = 'UNVERIFIED',
       health_state = 'UNKNOWN',
       health_observed_at = null,
       health_source_revision = null,
       updated_at = now()
  from legacy
  join genio_one_provider_credential_profile_revisions profile
    on profile.tenant_id = legacy.tenant_id
   and profile.profile_id = legacy.profile_id
   and profile.revision = 1
 where connection.tenant_id = legacy.tenant_id
   and connection.resource_id = legacy.resource_id
   and connection.connection_id = legacy.connection_id;

alter table genio_one_resource_connections
  drop constraint if exists genio_one_connections_downstream_identity_check;

alter table genio_one_resource_connections
  add constraint genio_one_connections_downstream_identity_check
  check (
    jsonb_typeof(downstream_identity) = 'object'
    and (
      (
        downstream_identity = '{"mode":"SERVICE","authentication":"PROVIDER_CREDENTIAL_PROFILE"}'::jsonb
        and provider_credential_profile_id is not null
        and provider_credential_profile_revision is not null
        and provider_credential_strategy_digest is not null
        and credential_ref is null
      )
      or (
        provider_credential_profile_id is null
        and provider_credential_profile_revision is null
        and provider_credential_strategy_digest is null
        and (
          (connection_kind = 'LLM' and downstream_identity = '{"mode":"NONE"}'::jsonb and credential_ref is null)
          or (connection_kind = 'API' and downstream_identity = '{"mode":"NONE"}'::jsonb and credential_ref is null)
          or (
            connection_kind = 'MCP'
            and (
              (downstream_identity = '{"mode":"NONE"}'::jsonb and credential_ref is null)
              or (downstream_identity = '{"mode":"SERVICE","authentication":"API_KEY"}'::jsonb and credential_ref is not null)
              or (downstream_identity = '{"mode":"USER_OAUTH"}'::jsonb and credential_ref is null)
              or (downstream_identity ->> 'mode' = 'USER_PASSTHROUGH' and credential_ref is null)
            )
          )
        )
      )
    )
  );

drop function genio_one_migration_080_canonical_json(jsonb);
