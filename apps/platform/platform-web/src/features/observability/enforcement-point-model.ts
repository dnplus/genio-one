export const enforcementPointIds = [
  "API_GATEWAY",
  "AI_GATEWAY",
  "ACCESS_GATEWAY",
  "ENDPOINT",
  "AGENT_RUNTIME",
] as const

export type EnforcementPointId = (typeof enforcementPointIds)[number]
export type EnforcementPointFilterValue = "ALL" | EnforcementPointId

export const enforcementPointQueryKey = "enforcement"

const labelKeys: Record<EnforcementPointFilterValue, string> = {
  ALL: "All enforcement points",
  API_GATEWAY: "API Gateway",
  AI_GATEWAY: "AI Gateway",
  ACCESS_GATEWAY: "Access Gateway",
  ENDPOINT: "Endpoint",
  AGENT_RUNTIME: "Agent Runtime",
}

function normalized(value: string): string {
  return value.trim().toUpperCase().replace(/[\s./:-]+/g, "_")
}

export function normalizeEnforcementPoint(value: string | null | undefined): EnforcementPointId | null {
  if (!value?.trim()) return null
  const candidate = normalized(value)
  if (candidate === "GATEWAY") return "API_GATEWAY"
  if (candidate === "API_GATEWAY" || candidate === "API_MANAGEMENT") return "API_GATEWAY"
  if (candidate === "AI_GATEWAY" || candidate === "AI_MCP_GATEWAY" || candidate === "MCP_GATEWAY") return "AI_GATEWAY"
  if (candidate === "ACCESS_GATEWAY" || candidate === "SECURE_ACCESS" || candidate === "SECURE_ACCESS_GATEWAY") return "ACCESS_GATEWAY"
  if (candidate === "ENDPOINT") return "ENDPOINT"
  if (candidate === "AGENT_RUNTIME" || candidate === "RUNTIME" || candidate === "RUNTIME_POLICY") return "AGENT_RUNTIME"
  if (candidate.includes("AI_MCP_GATEWAY") || candidate.includes("AI_GATEWAY")) return "AI_GATEWAY"
  if (candidate.includes("API_MANAGEMENT") || candidate.includes("API_GATEWAY")) return "API_GATEWAY"
  if (candidate.includes("ACCESS_GATEWAY") || candidate.includes("SECURE_ACCESS")) return "ACCESS_GATEWAY"
  if (candidate.includes("ENDPOINT")) return "ENDPOINT"
  if (candidate.includes("AGENT_RUNTIME") || candidate.includes("RUNTIME_POLICY")) return "AGENT_RUNTIME"
  return null
}

export function readEnforcementPointFilter(
  value: string | null | undefined,
  fallback: EnforcementPointFilterValue = "ALL",
): EnforcementPointFilterValue {
  if (value?.trim().toUpperCase() === "ALL") return "ALL"
  return normalizeEnforcementPoint(value) ?? fallback
}

export function writeEnforcementPointFilter(value: EnforcementPointFilterValue, replace = false) {
  const url = new URL(window.location.href)
  if (value === "ALL") url.searchParams.delete(enforcementPointQueryKey)
  else url.searchParams.set(enforcementPointQueryKey, value)
  url.searchParams.delete("lane")
  window.history[replace ? "replaceState" : "pushState"]({}, "", url)
}

export function matchesEnforcementPoint(
  value: string | null | undefined,
  filter: EnforcementPointFilterValue,
): boolean {
  return filter === "ALL" || normalizeEnforcementPoint(value) === filter
}

export function enforcementPointLabel(point: EnforcementPointFilterValue, overrides?: Partial<Record<EnforcementPointFilterValue, string>>): string {
  return overrides?.[point] ?? labelKeys[point]
}
