import { createHash } from "node:crypto"

export const MCP_OAUTH_HEADER_PREFIX = "x-genio-mcp-oauth-"

export function mcpOAuthHeaderName(connectionId: string): string {
  return `${MCP_OAUTH_HEADER_PREFIX}${createHash("sha256").update(connectionId).digest("hex").slice(0, 24)}`
}
