# CE starter project

This package contains a fictional activity-registration project, a GenioOne adapter for the Archify skill, and the Product Management plugin.

Archify executes through the governed MCP connector shipped under `apps/connectors/archify`. The Bot does not require an Endpoint. Its adapter uses the original renderer rather than embedding a pre-rendered result.

Product Management skills are vendored from `anthropics/knowledge-work-plugins` at commit `56026c70281ffd504d65c9bb8ca71f5ba6b8fd34`, with the upstream Apache-2.0 license. The Codex manifest adapts plugin discovery. Optional external MCP connections are omitted from this starter distribution; the skills can work from the supplied project material.

Sample input is fictional. Model responses, retrieved documentation, and generated diagrams are produced by the configured real services.
