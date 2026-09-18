alter table genio_one_resource_connections
  add column if not exists mcp_tool_namespace text;

create unique index if not exists genio_one_resource_connections_mcp_namespace_unique
  on genio_one_resource_connections (tenant_id, mcp_tool_namespace)
  where mcp_tool_namespace is not null;
