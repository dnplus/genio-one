delete from genio_one_platform_runtime_aggregate_report_history;
delete from genio_one_platform_runtime_aggregate_observed_states;
delete from genio_one_platform_runtime_aggregate_commands;

alter table genio_one_platform_runtime_capabilities
  drop constraint genio_one_platform_runtime_cap_preferred_protocol_version_check;

alter table genio_one_platform_runtime_capabilities
  drop constraint genio_one_platform_runtime_capabilitie_protocol_versions_check1;

update genio_one_platform_runtime_capabilities
set protocol_versions = '["genio.one.runtime.v1"]'::jsonb,
    preferred_protocol_version = 'genio.one.runtime.v1',
    row_revision = row_revision + 1,
    updated_at = now();

alter table genio_one_platform_runtime_capabilities
  add constraint genio_one_platform_runtime_cap_preferred_protocol_version_check
  check (preferred_protocol_version = 'genio.one.runtime.v1');

alter table genio_one_platform_runtime_capabilities
  add constraint genio_one_platform_runtime_capabilitie_protocol_versions_check1
  check (protocol_versions = '["genio.one.runtime.v1"]'::jsonb);
