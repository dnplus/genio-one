ALTER TABLE genio_one_mcp_discovery_operations
  DROP CONSTRAINT genio_one_mcp_discovery_operations_tenant_id_correlation_id_key;

ALTER TABLE genio_one_mcp_discovery_operations
  ADD CONSTRAINT genio_one_mcp_discovery_resource_correlation_key
  UNIQUE (tenant_id, resource_id, correlation_id);

DROP INDEX genio_one_mcp_discovery_active_connection_idx;

CREATE UNIQUE INDEX genio_one_mcp_discovery_active_connection_idx
  ON genio_one_mcp_discovery_operations (tenant_id, resource_id, connection_id)
  WHERE state IN ('PENDING', 'RUNNING');
