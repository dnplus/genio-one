import { createHash } from "node:crypto"

import type { McpDiscoveryCandidate, McpDiscoveryObservation } from "./contract"
import { mcpToolCapabilityId } from "../../../../../../runtimes/gateway/services/shared/mcp-tool-capability"

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

export function discoveryCandidates(
  connectionId: string,
  observation: McpDiscoveryObservation,
  publishedTools: readonly string[],
  previous: readonly McpDiscoveryCandidate[] = [],
): McpDiscoveryCandidate[] {
  const previousByTool = new Map(previous.map((candidate) => [candidate.tool_name, candidate]))
  return [...observation.tools].sort((left, right) => left.name.localeCompare(right.name)).map((tool) => {
    const revisionDigest = digest(tool)
    const old = previousByTool.get(tool.name)
    const state = publishedTools.includes(tool.name)
      ? "PUBLISHED" as const
      : old?.revision_digest === revisionDigest && (old.state === "IGNORED" || old.state === "BLOCKED")
        ? old.state
        : "NEW" as const
    return {
      candidate_id: `mcp-candidate-${digest([connectionId, tool.name])}`,
      capability_id: mcpToolCapabilityId(tool.name),
      tool_name: tool.name,
      revision_digest: revisionDigest,
      state,
    }
  })
}
