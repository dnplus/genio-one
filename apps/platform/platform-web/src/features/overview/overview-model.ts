import type { GatewayActivityTrendPoint, OverviewSnapshot, ResourceKind } from "@/domain/contracts"
import { isDecisionAuditEvent } from "@/domain/audit-events"
import { normalizeEnforcementPoint } from "@/features/observability/enforcement-point-model"
import { dateKeyInTimeZone } from "@/lib/personal-preferences"

export type OverviewNodeId = "clients" | "endpoints" | "gateway" | "resources"
export type ProductLane = "ALL" | "AI_MCP_GATEWAY" | "API_MANAGEMENT" | "SECURE_ACCESS" | "ENDPOINT"
export type NormalizedOutcome = "success" | "denied" | "blocked" | "rateLimited" | "failed"

export interface BreakdownItem {
  label: string
  value: number | string
  status?: "healthy" | "warning" | "muted"
  filter?: string
  target?: "activity" | "runtimes" | "resources" | "applications" | "people" | "agents"
}

export interface OverviewNode {
  id: OverviewNodeId
  label: string
  value: number
  detail: string
  detailParams?: Record<string, string | number>
  progress: number
  breakdown: BreakdownItem[]
  target: "activity" | "runtimes" | "resources" | "applications" | "people" | "agents"
}

export interface TrendRecord {
  occurredAt: number
  day?: string
  count: number
  lane: Exclude<ProductLane, "ALL">
  outcome: NormalizedOutcome
}

export interface TrendBucket {
  key: string
  label: string
  success: number
  denied: number
  blocked: number
  rateLimited: number
  failed: number
  total: number
}

export interface TrendDateRange {
  from: Date
  to: Date
}

const capabilityLabels = {
  AI_MCP_GATEWAY: "AI / MCP Gateway",
  API_MANAGEMENT: "API Gateway",
  SECURE_ACCESS: "Secure Access",
} as const

function capabilityBreakdown(data: OverviewSnapshot): BreakdownItem[] {
  const gatewayReports = data.runtimes
    .filter((runtime) => runtime.runtime_kind === "GATEWAY")
    .flatMap((runtime) => runtime.observed_state ? [runtime.observed_state] : [])

  return Object.entries(capabilityLabels).map(([component, label]) => {
    const observations = gatewayReports.flatMap((report) =>
      report.components.filter((candidate) => runtimeComponentLane(candidate.component) === component),
    )
    if (!observations.length) {
      const awaitingReport = data.runtimes.some((runtime) => runtime.runtime_kind === "GATEWAY" && !runtime.observed_state) || data.gatewayRegistrations.some((registration) => registration.state === "ACTIVE" && !data.runtimes.some((runtime) => runtime.runtime_id === registration.runtime_id && runtime.observed_state))
      return { label, value: awaitingReport ? "Awaiting report" : "Not reported", status: awaitingReport ? "warning" : "muted", filter: component }
    }
    const degraded = observations.some((observation) => observation.health === "DEGRADED") || data.runtimes.some((runtime) => runtime.observed_state?.components.some((candidate) => runtimeComponentLane(candidate.component) === component) && (runtime.operator_state !== "READY" || !runtime.connected || !runtime.in_sync))
    return { label, value: degraded ? "Degraded" : "Ready", status: degraded ? "warning" : "healthy", filter: component }
  })
}

export function runtimeFilterForProductLane(value: string): string {
  return normalizeEnforcementPoint(value) ?? "GATEWAY"
}

function resourceBreakdown(data: OverviewSnapshot): BreakdownItem[] {
  return (["LLM", "MCP", "API", "SAAS"] as ResourceKind[]).map((kind) => ({
    label: kind === "SAAS" ? "SaaS" : kind,
    value: data.resources.filter((resource) => resource.kind === kind).length,
    filter: kind,
  }))
}

export function buildOverviewNodes(data: OverviewSnapshot): OverviewNode[] {
  const endpointRuntimes = data.runtimes.filter((runtime) => runtime.runtime_kind === "ENDPOINT")
  const gatewayRuntimes = data.runtimes.filter((runtime) => runtime.runtime_kind === "GATEWAY")
  const verifiedActingClients = new Set(
    data.activity.recent_activity.flatMap((event) =>
      event.client.status === "VERIFIED" ? [event.client.acting_client_id] : [],
    ),
  )
  const subjects = data.identity?.subjects ?? []
  const personSubjects = subjects.filter((subject) => subject.kind === "PERSON").length
  const agentSubjects = data.identity?.subjects.filter((subject) => subject.kind === "AGENT").length ?? 0
  const applicationSubjectIds = new Set([
    ...subjects.filter((subject) => subject.kind === "APPLICATION").map((subject) => subject.subject_id),
    ...data.applications.map((application) => application.subject_id),
  ])
  const canonicalIdentityCount = personSubjects + agentSubjects + applicationSubjectIds.size
  const gatewayNames = data.gatewayRegistrations
    .filter((registration) => registration.state === "ACTIVE")
    .map((registration) => registration.display_name)
  const fallbackGatewayNames = gatewayRuntimes.map((runtime) => runtime.runtime_id)

  return [
    {
      id: "clients",
      label: "Identities",
      value: canonicalIdentityCount,
      detail: "Canonical Person, Application, and Agent subjects used by One Policy.",
      progress: canonicalIdentityCount ? 100 : 0,
      breakdown: [
        { label: "Person", value: personSubjects, target: "people", filter: "PERSON" },
        { label: "Applications", value: applicationSubjectIds.size, target: "applications" },
        { label: "Agents", value: agentSubjects, target: "agents" },
        { label: "Observed clients", value: verifiedActingClients.size, status: "healthy", target: "activity", filter: "VERIFIED" },
      ],
      target: "people",
    },
    {
      id: "endpoints",
      label: "Endpoints",
      value: endpointRuntimes.length,
      detail: "{{count}} ready",
      detailParams: { count: endpointRuntimes.filter((runtime) => runtime.operator_state === "READY").length },
      progress: endpointRuntimes.length
        ? Math.round((endpointRuntimes.filter((runtime) => runtime.operator_state === "READY").length / endpointRuntimes.length) * 100)
        : 0,
      breakdown: [
        { label: "Ready", value: endpointRuntimes.filter((runtime) => runtime.operator_state === "READY").length, status: "healthy", filter: "ENDPOINT READY" },
        { label: "Degraded", value: endpointRuntimes.filter((runtime) => runtime.operator_state === "DEGRADED").length, status: "warning", filter: "ENDPOINT DEGRADED" },
        { label: "Offline", value: endpointRuntimes.filter((runtime) => runtime.operator_state === "OFFLINE").length, status: "warning", filter: "ENDPOINT OFFLINE" },
        { label: "Out of sync", value: endpointRuntimes.filter((runtime) => runtime.operator_state === "OUT_OF_SYNC").length, status: "warning", filter: "ENDPOINT OUT_OF_SYNC" },
      ],
      target: "runtimes",
    },
    {
      id: "gateway",
      label: "Genio Gateway",
      value: gatewayNames.length || gatewayRuntimes.length,
      detail: [...new Set(gatewayNames.length ? gatewayNames : fallbackGatewayNames)].join(", ") || "No registered Gateways",
      progress: gatewayRuntimes.length
        ? Math.round((gatewayRuntimes.filter((runtime) => runtime.operator_state === "READY").length / gatewayRuntimes.length) * 100)
        : 0,
      breakdown: capabilityBreakdown(data),
      target: "runtimes",
    },
    {
      id: "resources",
      label: "Resource catalog",
      value: data.resources.length,
      detail: "Governed catalog objects, grouped by Resource type.",
      progress: data.resources.length ? 100 : 0,
      breakdown: resourceBreakdown(data),
      target: "resources",
    },
  ]
}

function normalizeAuditOutcome(outcome: string): NormalizedOutcome {
  const normalized = outcome.toUpperCase()
  if (normalized.includes("RATE")) return "rateLimited"
  if (normalized.includes("DENY") || normalized.includes("UNAUTH")) return "denied"
  if (normalized.includes("BLOCK")) return "blocked"
  if (normalized.includes("FAIL") || normalized.includes("ERROR")) return "failed"
  return "success"
}

function productLaneForEnforcementPoint(value: string | null | undefined, resourceKind?: ResourceKind): Exclude<ProductLane, "ALL"> {
  const point = normalizeEnforcementPoint(value)
  if (point === "AI_GATEWAY") return "AI_MCP_GATEWAY"
  if (point === "ACCESS_GATEWAY") return "SECURE_ACCESS"
  if (point === "ENDPOINT") return "ENDPOINT"
  if (point === "API_GATEWAY") return "API_MANAGEMENT"
  if (resourceKind === "LLM" || resourceKind === "MCP") return "AI_MCP_GATEWAY"
  if (resourceKind === "SAAS") return "SECURE_ACCESS"
  return "API_MANAGEMENT"
}

function runtimeComponentLane(value: string | null | undefined): Exclude<ProductLane, "ALL"> | null {
  const point = normalizeEnforcementPoint(value)
  if (!point || point === "AGENT_RUNTIME") return null
  return productLaneForEnforcementPoint(point)
}

export function buildTrendRecords(data: OverviewSnapshot): TrendRecord[] {
  const resources = new Map(data.resources.map((resource) => [resource.resource_id, resource.kind]))
  const seenCorrelations = new Set<string>()
  const records: TrendRecord[] = []

  for (const event of data.apiActivity.events) {
    seenCorrelations.add(event.correlation_id)
    records.push({
      occurredAt: event.occurred_at,
      count: 1,
      lane: productLaneForEnforcementPoint(event.enforcement_point_id),
      outcome: normalizeAuditOutcome(event.outcome),
    })
  }

  for (const event of data.activity.recent_activity) {
    seenCorrelations.add(event.correlation_id)
    records.push({
      occurredAt: event.observed_at,
      count: Math.max(1, event.request_count),
      lane: "ENDPOINT",
      outcome: event.route === "BLOCK" ? "blocked" : "success",
    })
  }

  for (const event of data.auditEvents.filter(isDecisionAuditEvent)) {
    if (event.kind !== "INVOCATION_OUTCOME" || seenCorrelations.has(event.correlation_id) || !event.resource_id) continue
    const kind = resources.get(event.resource_id)
    if (!kind) continue
    const lane = productLaneForEnforcementPoint(event.enforcement_point_id, kind)
    records.push({ occurredAt: event.occurred_at, count: 1, lane, outcome: normalizeAuditOutcome(event.outcome) })
  }

  return records
}

export function buildAggregatedTrendRecords(points: GatewayActivityTrendPoint[]): TrendRecord[] {
  return points.map((point) => ({
    occurredAt: Date.parse(`${point.day}T00:00:00Z`) / 1_000,
    day: point.day,
    count: point.count,
    lane: productLaneForEnforcementPoint(point.enforcement_point_id),
    outcome: normalizeAuditOutcome(point.outcome),
  }))
}

export function buildTrendBuckets(records: TrendRecord[], lane: ProductLane, range: TrendDateRange, language: string, timeZone: string): TrendBucket[] {
  const from = new Date(Date.UTC(range.from.getFullYear(), range.from.getMonth(), range.from.getDate()))
  const to = new Date(Date.UTC(range.to.getFullYear(), range.to.getMonth(), range.to.getDate()))
  const days = Math.max(1, Math.floor((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1_000)) + 1)
  const buckets = Array.from({ length: days }, (_, index) => {
    const date = new Date(from)
    date.setUTCDate(from.getUTCDate() + index)
    return {
      key: date.toISOString().slice(0, 10),
      label: new Intl.DateTimeFormat(language, { month: "numeric", day: "numeric", timeZone: "UTC" }).format(date),
      success: 0,
      denied: 0,
      blocked: 0,
      rateLimited: 0,
      failed: 0,
      total: 0,
    } satisfies TrendBucket
  })
  const byDay = new Map(buckets.map((bucket) => [bucket.key, bucket]))

  for (const record of records) {
    if (lane !== "ALL" && record.lane !== lane) continue
    const bucket = byDay.get(record.day ?? dateKeyInTimeZone(record.occurredAt, timeZone))
    if (!bucket) continue
    bucket[record.outcome] += record.count
    bucket.total += record.count
  }
  return buckets
}
