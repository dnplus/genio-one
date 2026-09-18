alter table genio_one_resource_connections
  add column if not exists provider_credential_profile_id text,
  add column if not exists provider_credential_profile_revision bigint,
  add column if not exists provider_credential_strategy_digest text;

alter table genio_one_resource_connections
  add constraint genio_one_connection_provider_credential_binding_check
  check (
    (
      provider_credential_profile_id is null
      and provider_credential_profile_revision is null
      and provider_credential_strategy_digest is null
    )
    or
    (
      length(trim(provider_credential_profile_id)) > 0
      and provider_credential_profile_revision > 0
      and provider_credential_strategy_digest ~ '^[a-f0-9]{64}$'
    )
  );

alter table genio_one_resource_connections
  add constraint genio_one_connection_provider_credential_revision_fk
  foreign key (tenant_id, provider_credential_profile_id, provider_credential_profile_revision)
  references genio_one_provider_credential_profile_revisions (tenant_id, profile_id, revision);
