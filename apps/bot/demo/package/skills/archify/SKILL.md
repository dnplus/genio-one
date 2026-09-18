---
name: archify
description: Create a validated interactive architecture diagram from project requirements through the governed Archify MCP renderer, then present its HTML artifact.
---

# Archify for GenioOne

Use the Archify MCP tools available through the user's governed GenioOne connection.

1. Call `archify_schema` to obtain the architecture schema and a structural example.
2. Author a fresh specification from the user's requirements. Keep one main path, short labels and at most twelve primary nodes. Use the example for field shape, not project facts.
3. Call `archify_render` with the specification. The service runs the pinned Archify validator and renderer.
4. If validation fails, repair the reported problem and retry. After two attempts without improvement, report the remaining issue.
5. Present the returned HTML artifact and summarize the architecture. A diagram is complete only when the renderer returns a successful receipt and artifact digest.

For a missing or disabled connection, direct the user to the Archify connection setup. Preserve the requirements so they can retry after configuration.

The rendering service owns Node execution and artifact validation. This skill operates in a Bot with no Endpoint.
