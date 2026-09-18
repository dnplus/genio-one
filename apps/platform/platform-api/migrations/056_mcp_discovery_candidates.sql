alter table genio_one_mcp_discovery_operations
  add column if not exists candidates jsonb not null default '[]'::jsonb;

alter table genio_one_mcp_discovery_operations
  add constraint genio_one_mcp_discovery_candidates_array check (jsonb_typeof(candidates) = 'array');
