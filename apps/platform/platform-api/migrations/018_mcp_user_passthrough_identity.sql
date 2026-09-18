-- Admit one per-user MCP credential header. The Control Plane stores only the
-- allowlisted header name; Envoy AI Gateway performs per-backend forwarding.

alter table genio_one_resource_connections
  drop constraint genio_one_connections_downstream_identity_check;

alter table genio_one_resource_connections
  add constraint genio_one_connections_downstream_identity_check
  check (
    jsonb_typeof(downstream_identity) = 'object'
    and (
      downstream_identity = '{"mode":"NONE"}'::jsonb
      or downstream_identity = '{"mode":"SERVICE","authentication":"API_KEY"}'::jsonb
      or (
        downstream_identity->>'mode' = 'USER_PASSTHROUGH'
        and jsonb_typeof(downstream_identity->'forward_headers') = 'array'
        and downstream_identity = jsonb_build_object(
          'mode', 'USER_PASSTHROUGH',
          'forward_headers', downstream_identity->'forward_headers'
        )
        and jsonb_array_length(downstream_identity->'forward_headers') = 1
        and jsonb_typeof(downstream_identity->'forward_headers'->0) = 'object'
        and downstream_identity->'forward_headers'->0 = jsonb_build_object(
          'name', downstream_identity->'forward_headers'->0->>'name'
        )
        and downstream_identity->'forward_headers'->0->>'name' ~ '^[a-z0-9-]+$'
        and downstream_identity->'forward_headers'->0->>'name' not like 'x-genio-%'
        and downstream_identity->'forward_headers'->0->>'name' not in (
          'authorization',
          'cookie',
          'host',
          'mcp-session-id',
          'proxy-authorization',
          'x-request-id'
        )
      )
    )
    and (
      connection_kind <> 'MCP'
      or (downstream_identity = '{"mode":"NONE"}'::jsonb and credential_ref is null)
      or (
        downstream_identity = '{"mode":"SERVICE","authentication":"API_KEY"}'::jsonb
        and credential_ref is not null
      )
      or (
        downstream_identity->>'mode' = 'USER_PASSTHROUGH'
        and credential_ref is null
      )
    )
  );
