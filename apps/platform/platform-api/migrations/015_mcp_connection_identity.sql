-- Separate an MCP upstream from an LLM Provider Profile.
--
-- A Connection remains Resource-owned, but MCP is a protocol endpoint rather
-- than an AI Provider. Outbound identity is explicit and Connection-owned;
-- the first walking skeleton admits only an unauthenticated upstream.

alter table genio_one_resource_connections
  add column connection_kind text not null default 'LLM',
  add column downstream_identity jsonb not null default '{"mode":"NONE"}'::jsonb;

alter table genio_one_resource_connections
  alter column provider_type drop not null,
  alter column provider_profile_id drop not null;

alter table genio_one_resource_connections
  add constraint genio_one_connections_kind_check
  check (connection_kind in ('LLM', 'MCP')),
  add constraint genio_one_connections_kind_provider_check
  check (
    (connection_kind = 'LLM' and provider_type is not null and provider_profile_id is not null)
    or
    (connection_kind = 'MCP' and provider_type is null and provider_profile_id is null)
  ),
  add constraint genio_one_connections_downstream_identity_check
  check (
    jsonb_typeof(downstream_identity) = 'object'
    and downstream_identity = '{"mode":"NONE"}'::jsonb
  );
