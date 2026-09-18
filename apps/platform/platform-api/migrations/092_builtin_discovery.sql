alter table genio_one_resources add column builtin_service text;
alter table genio_one_resources add constraint genio_one_builtin_service_check
  check (builtin_service is null or (builtin_service = 'DISCOVERY' and kind = 'MCP'));
create unique index genio_one_builtin_service_unique on genio_one_resources (tenant_id, builtin_service) where builtin_service is not null;
