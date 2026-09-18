import { createHash } from "node:crypto"

export function mcpToolCapabilityId(toolName: string): string {
  return `mcp-tool-${createHash("sha256").update(toolName).digest("hex").slice(0, 32)}`
}
