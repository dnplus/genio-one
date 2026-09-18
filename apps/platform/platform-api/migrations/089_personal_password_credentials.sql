create table if not exists genio_one_personal_password_credentials (
  tenant_id text not null,
  resource_id text not null,
  connection_id text not null,
  subject_id text not null,
  sealed_value text not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, resource_id, connection_id, subject_id),
  foreign key (tenant_id, resource_id, connection_id)
    references genio_one_resource_connections (tenant_id, resource_id, connection_id) on delete cascade
);

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
              or (downstream_identity ->> 'mode' = 'USER_OAUTH' and credential_ref is null and (downstream_identity - 'oauth_client') = '{"mode":"USER_OAUTH"}'::jsonb and (not (downstream_identity ? 'oauth_client') or jsonb_typeof(downstream_identity->'oauth_client') = 'object'))
              or (downstream_identity = '{"mode":"USER_PASSWORD"}'::jsonb and credential_ref is null)
              or (downstream_identity ->> 'mode' = 'USER_PASSTHROUGH' and credential_ref is null)
            )
          )
        )
      )
    )
  );

