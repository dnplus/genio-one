import type { ThreadItem } from "../server/generated/v2/ThreadItem"
import type { JsonValue } from "../server/generated/serde_json/JsonValue"

export const MCP_HTML_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024

export interface McpHtmlArtifact {
  name: string
  mimeType: "text/html"
  text: string
  sha256: string
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function validName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._ -]*\.html$/i.test(value) && !value.includes("..")
}

function validArtifact(value: unknown): value is McpHtmlArtifact {
  const artifact = record(value)
  return Boolean(
    artifact
    && validName(artifact.name)
    && artifact.mimeType === "text/html"
    && typeof artifact.text === "string"
    && new TextEncoder().encode(artifact.text).byteLength <= MCP_HTML_ARTIFACT_MAX_BYTES
    && typeof artifact.sha256 === "string"
    && /^[a-f0-9]{64}$/i.test(artifact.sha256),
  )
}

export function mcpHtmlArtifacts(item: ThreadItem | undefined): McpHtmlArtifact[] {
  if (item?.type !== "mcpToolCall") return []
  const meta = record(item.result?._meta)
  const artifacts = meta?.["genio/artifacts"]
  return Array.isArray(artifacts) ? artifacts.filter(validArtifact) : []
}

export function withMcpHtmlArtifacts(item: ThreadItem, artifacts: McpHtmlArtifact[]): ThreadItem {
  if (item.type !== "mcpToolCall" || !item.result) return item
  const meta = record(item.result._meta)
  if (!meta || !("genio/artifacts" in meta)) return item
  const { ["genio/artifacts"]: _artifacts, ...rest } = meta
  return {
    ...item,
    result: {
      ...item.result,
      _meta: (artifacts.length ? { ...rest, "genio/artifacts": artifacts } : rest) as JsonValue,
    },
  }
}
