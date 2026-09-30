# Pinned discovery schemas

These files are unmodified upstream schemas used for offline contract tests.

- [ard-entry.schema.json](https://github.com/ards-project/ard-spec/blob/aa3e598bb7752a9175897823234311216acfa864/spec/schemas/ard-entry.schema.json) — SHA-256 `011b86d55fd5d2883dffae3f0577d26f5efb56ca866eb079edbc78a628f95499`.
- [mcp-server-card.schema.json](https://github.com/modelcontextprotocol/ext-server-card/blob/526201bbc80231daa40ffcdecfc9da4e54e5dc93/schema.json) — SHA-256 `2c772b51edb367f154771d84ddbae87ddba00a624422c8e46f218a9ac03bf042`.

ARD v0.91 is a Proposal. MCP Server Card is Experimental at the pinned commit. Both repositories use Apache-2.0; their licenses are preserved in LICENSE-ARD and LICENSE-MCP-SERVER-CARD.

Validate the ARD document against `#/$defs/ArdManifest` and the Server Card against `#/$defs/ServerCard`. No remote schema fetching is needed. The upstream ARD `TrustManifest` casing mismatch is not patched here; the publisher does not emit a trust envelope.
