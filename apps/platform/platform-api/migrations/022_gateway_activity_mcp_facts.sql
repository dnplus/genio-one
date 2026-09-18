alter table genio_one_gateway_activities
  add column if not exists mcp_method text,
  add column if not exists mcp_tool text,
  add column if not exists mcp_backend text;
