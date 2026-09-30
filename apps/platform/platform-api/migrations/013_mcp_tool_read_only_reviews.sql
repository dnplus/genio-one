ALTER TABLE genio_one_resource_connections
    ADD COLUMN mcp_tool_reviews jsonb DEFAULT '[]'::jsonb NOT NULL;

ALTER TABLE genio_one_resource_connections
    ADD CONSTRAINT genio_one_resource_connections_mcp_tool_reviews_array
    CHECK ((jsonb_typeof(mcp_tool_reviews) = 'array'::text));
