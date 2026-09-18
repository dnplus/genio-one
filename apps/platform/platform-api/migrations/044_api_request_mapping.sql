alter table genio_one_resource_connections
  drop constraint if exists genio_one_connections_kind_check,
  drop constraint if exists genio_one_connections_kind_provider_check,
  drop constraint if exists genio_one_connections_downstream_identity_check;

alter table genio_one_resource_connections
  add column if not exists request_mapping jsonb,
  add constraint genio_one_connections_kind_check
  check (connection_kind in ('LLM', 'MCP', 'API')),
  add constraint genio_one_connections_kind_provider_check
  check (
    (connection_kind = 'LLM' and provider_type is not null and provider_profile_id is not null)
    or
    (connection_kind in ('MCP', 'API') and provider_type is null and provider_profile_id is null)
  ),
  add constraint genio_one_connections_request_mapping_check
  check (
    (connection_kind = 'API' and request_mapping is not null and jsonb_typeof(request_mapping) = 'object')
    or
    (connection_kind <> 'API' and request_mapping is null)
  ),
  add constraint genio_one_connections_downstream_identity_check
  check (
    jsonb_typeof(downstream_identity) = 'object'
    and (
      (connection_kind = 'LLM' and downstream_identity = '{"mode":"NONE"}'::jsonb)
      or
      (connection_kind = 'API' and downstream_identity = '{"mode":"NONE"}'::jsonb and credential_ref is null)
      or
      (
        connection_kind = 'MCP'
        and (
          (downstream_identity = '{"mode":"NONE"}'::jsonb and credential_ref is null)
          or (downstream_identity = '{"mode":"SERVICE","authentication":"API_KEY"}'::jsonb and credential_ref is not null)
          or (downstream_identity = '{"mode":"USER_OAUTH"}'::jsonb and credential_ref is null)
          or (downstream_identity->>'mode' = 'USER_PASSTHROUGH' and credential_ref is null)
        )
      )
    )
  );

alter table genio_one_resources
  add column if not exists api_metadata jsonb,
  add constraint genio_one_resources_api_metadata_check
  check (
    (kind = 'API' and (api_metadata is null or jsonb_typeof(api_metadata) = 'object'))
    or
    (kind <> 'API' and api_metadata is null)
  );
