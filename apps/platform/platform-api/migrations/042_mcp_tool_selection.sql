alter table genio_one_resource_connections
  add column if not exists mcp_selected_tools text[] not null default '{}',
  add column if not exists mcp_tool_selection_operation_id text;

alter table genio_one_resource_connections
  add constraint genio_one_resource_connections_mcp_tool_selection_source_fk
  foreign key (tenant_id, mcp_tool_selection_operation_id)
  references genio_one_mcp_discovery_operations (tenant_id, operation_id);
