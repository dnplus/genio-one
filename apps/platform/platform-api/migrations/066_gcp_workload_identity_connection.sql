alter table genio_one_resource_connections
  drop constraint if exists genio_one_connections_downstream_identity_check;

alter table genio_one_resource_connections
  add constraint genio_one_connections_downstream_identity_check
  check (
    jsonb_typeof(downstream_identity) = 'object'
    and (
      (
        connection_kind = 'LLM'
        and (
          downstream_identity = '{"mode":"NONE"}'::jsonb
          or (
            provider_type = 'GCP_VERTEX_AI'
            and credential_ref is not null
            and downstream_identity->>'mode' = 'SERVICE'
            and downstream_identity->>'authentication' = 'GCP_WORKLOAD_IDENTITY'
            and jsonb_typeof(downstream_identity->'gcp_workload_identity') = 'object'
          )
        )
      )
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
