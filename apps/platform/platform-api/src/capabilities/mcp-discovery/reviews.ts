import { PlatformApiError } from "../errors"
import type { McpToolReview } from "../connections/contract"
import type { McpDiscoveryCandidate, McpDiscoveryObservation } from "./contract"

export function pruneMcpToolReviews(
  reviews: readonly McpToolReview[] | undefined,
  candidates: readonly McpDiscoveryCandidate[],
): McpToolReview[] {
  const revisions = new Map(candidates.map((candidate) => [candidate.tool_name, candidate.revision_digest]))
  return (reviews ?? [])
    .filter((review) => revisions.get(review.tool_name) === review.source_revision_digest)
    .sort((left, right) => left.tool_name.localeCompare(right.tool_name))
}

export function mcpToolReviewForCandidate(input: {
  observation: McpDiscoveryObservation
  candidate: McpDiscoveryCandidate
  approvedBySubjectId: string
  approvedAt: number
}): McpToolReview {
  const tool = input.observation.tools.find((value) => value.name === input.candidate.tool_name)
  if (!tool || tool.input_schema === undefined) {
    throw new PlatformApiError("MCP_TOOL_REVIEW_METADATA_REQUIRED", 409)
  }
  const inputSchema = tool.input_schema as Record<string, unknown>
  if (Array.isArray(inputSchema) || inputSchema.type !== "object") {
    throw new PlatformApiError("MCP_TOOL_REVIEW_INPUT_SCHEMA_INVALID", 409)
  }
  return {
    tool_name: input.candidate.tool_name,
    source_revision_digest: input.candidate.revision_digest,
    execution_mode: "AUTO_READ_ONLY",
    source_read_only_hint: tool.read_only_hint === true,
    title: tool.title,
    description: tool.description,
    input_schema: structuredClone(inputSchema),
    approved_by_subject_id: input.approvedBySubjectId,
    approved_at: input.approvedAt,
  }
}

export function replaceMcpToolReview(
  reviews: readonly McpToolReview[] | undefined,
  review: McpToolReview | null,
  toolName: string,
): McpToolReview[] {
  return [...(reviews ?? []).filter((value) => value.tool_name !== toolName), ...(review ? [review] : [])]
    .sort((left, right) => left.tool_name.localeCompare(right.tool_name))
}
