ALTER TABLE genio_one_mcp_oauth_bindings
    DROP CONSTRAINT genio_one_mcp_oauth_bindings_pkey,
    ADD CONSTRAINT genio_one_mcp_oauth_bindings_pkey
        PRIMARY KEY (tenant_id, resource_id, connection_id, subject_id);
