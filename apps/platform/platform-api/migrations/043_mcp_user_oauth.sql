alter table genio_one_resource_connections
  drop constraint if exists genio_one_connections_downstream_identity_check;

alter table genio_one_resource_connections
  add constraint genio_one_connections_downstream_identity_check
  check (
    jsonb_typeof(downstream_identity) = 'object'
    and (
      downstream_identity = '{"mode":"NONE"}'::jsonb
      or downstream_identity = '{"mode":"SERVICE","authentication":"API_KEY"}'::jsonb
      or downstream_identity = '{"mode":"USER_OAUTH"}'::jsonb
      or (
        downstream_identity->>'mode' = 'USER_PASSTHROUGH'
        and jsonb_typeof(downstream_identity->'forward_headers') = 'array'
        and downstream_identity = jsonb_build_object(
          'mode', 'USER_PASSTHROUGH',
          'forward_headers', downstream_identity->'forward_headers'
        )
        and jsonb_array_length(downstream_identity->'forward_headers') = 1
      )
    )
  );

create table if not exists genio_one_mcp_oauth_sessions (
  tenant_id text not null,
  session_id text not null,
  state_hash text not null unique,
  resource_id text not null,
  connection_id text not null,
  subject_id text not null,
  return_url text not null,
  sealed_state text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, session_id),
  foreign key (tenant_id, resource_id, connection_id)
    references genio_one_resource_connections (tenant_id, resource_id, connection_id)
    on delete cascade
);

create table if not exists genio_one_mcp_oauth_bindings (
  tenant_id text not null,
  resource_id text not null,
  connection_id text not null,
  subject_id text not null,
  issuer text not null,
  resource_url text not null,
  sealed_state text not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, connection_id, subject_id),
  foreign key (tenant_id, resource_id, connection_id)
    references genio_one_resource_connections (tenant_id, resource_id, connection_id)
    on delete cascade
);

create index if not exists genio_one_mcp_oauth_sessions_expiry_idx
  on genio_one_mcp_oauth_sessions (expires_at);
