-- Admit one authenticated MCP outbound identity mode. The credential remains
-- a reference; Envoy AI Gateway performs the actual backend injection.

alter table genio_one_resource_connections
  drop constraint genio_one_connections_downstream_identity_check;

alter table genio_one_resource_connections
  add constraint genio_one_connections_downstream_identity_check
  check (
    jsonb_typeof(downstream_identity) = 'object'
    and downstream_identity in (
      '{"mode":"NONE"}'::jsonb,
      '{"mode":"SERVICE","authentication":"API_KEY"}'::jsonb
    )
    and (
      connection_kind <> 'MCP'
      or (downstream_identity = '{"mode":"NONE"}'::jsonb and credential_ref is null)
      or (
        downstream_identity = '{"mode":"SERVICE","authentication":"API_KEY"}'::jsonb
        and credential_ref is not null
      )
    )
  );
