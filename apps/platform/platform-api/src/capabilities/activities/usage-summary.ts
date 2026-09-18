import type { AiUsageDashboard, GatewayActivityEvent } from "./contract"

export interface UsageSummaryEvent {
  event: GatewayActivityEvent
  resourceDisplayName?: string
}

function add(group: Map<string, number>, key: string, amount: number) {
  group.set(key, (group.get(key) ?? 0) + amount)
}

function utcDayStart(epochSeconds: number) {
  const date = new Date(epochSeconds * 1_000)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 1_000
}

export function summarizeGatewayActivities(input: {
  tenantId: string
  from: number
  to: number
  events: UsageSummaryEvent[]
}): AiUsageDashboard {
  const events = input.events.filter(({ event }) =>
    event.tenant_id === input.tenantId && event.occurred_at >= input.from && event.occurred_at <= input.to)
  const priced = events.filter(({ event }) => event.cost_estimation_status === "ESTIMATED")
  const unpriced = events.filter(({ event }) => event.cost_estimation_status === "UNPRICED")
  const subjects = new Set(events.flatMap(({ event }) => event.subject_id ? [event.subject_id] : []))
  const aiResources = new Set(events.flatMap(({ event }) =>
    event.provider_id !== null || event.effective_model_id !== null || event.total_tokens !== null
      ? [event.resource_id]
      : []))
  const blocked = events.filter(({ event }) =>
    event.outcome === "DENIED" || event.outcome === "BLOCKED" ||
    event.outcome === "UNAUTHENTICATED" || event.outcome === "RATE_LIMITED").length

  const currencyCost = new Map<string, number>()
  const currencyCount = new Map<string, number>()
  const resourceCost = new Map<string, number>()
  const resourceNames = new Map<string, string>()
  const subjectCost = new Map<string, number>()
  const departmentCost = new Map<string, number>()
  const trendCost = new Map<string, number>()

  for (const { event, resourceDisplayName } of priced) {
    const currency = event.estimated_cost_currency
    const amount = event.estimated_cost_micros
    if (currency === null || amount === null) continue
    add(currencyCost, currency, amount)
    add(currencyCount, currency, 1)
    const resourceKey = `${event.resource_id}\u0000${currency}`
    add(resourceCost, resourceKey, amount)
    resourceNames.set(event.resource_id, resourceDisplayName ?? event.resource_id)
    if (event.subject_id) add(subjectCost, `${event.subject_id}\u0000${currency}`, amount)
    add(departmentCost, `\u0000${currency}`, amount)
    add(trendCost, `${utcDayStart(event.occurred_at)}\u0000${currency}`, amount)
  }

  const split = (key: string) => key.split("\u0000") as [string, string]
  return {
    tenant_id: input.tenantId,
    from: input.from,
    to: input.to,
    active_user_count: subjects.size,
    ai_resource_count: aiResources.size,
    route_distribution: {
      direct: 0,
      managed: events.length - blocked,
      block: blocked,
    },
    usage: {
      request_count: events.length,
      tool_call_count: events.filter(({ event }) => event.mcp_tool !== null).length,
      request_bytes: 0,
      response_bytes: 0,
      input_tokens: events.reduce((sum, { event }) => sum + (event.input_tokens ?? 0), 0),
      output_tokens: events.reduce((sum, { event }) => sum + (event.output_tokens ?? 0), 0),
      total_tokens: events.reduce((sum, { event }) => sum + (event.total_tokens ?? 0), 0),
    },
    cost_by_currency: [...currencyCost].map(([currency, total_cost_micros]) => ({
      currency,
      total_cost_micros,
      priced_record_count: currencyCount.get(currency) ?? 0,
    })),
    cost_by_resource: [...resourceCost].map(([key, total_cost_micros]) => {
      const [resource_id, currency] = split(key)
      return { resource_id, display_name: resourceNames.get(resource_id) ?? resource_id, currency, total_cost_micros }
    }),
    cost_by_subject: [...subjectCost].map(([key, total_cost_micros]) => {
      const [subject_id, currency] = split(key)
      return { subject_id, display_name: null, department: null, currency, total_cost_micros }
    }),
    cost_by_department: [...departmentCost].map(([key, total_cost_micros]) => {
      const [, currency] = split(key)
      return { department: null, currency, total_cost_micros }
    }),
    cost_trend: [...trendCost].map(([key, total_cost_micros]) => {
      const [day, currency] = split(key)
      return { day_start: Number(day), currency, total_cost_micros }
    }).sort((left, right) => left.day_start - right.day_start),
    resource_budgets: [],
    priced_record_count: priced.length,
    unpriced_record_count: unpriced.length,
  }
}
