import type { GatewayActivityStore } from "./module"
import { summarizeGatewayActivities } from "./usage-summary"

function localDay(timestamp: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp * 1_000))
  const part = (type: string) => parts.find((value) => value.type === type)?.value ?? ""
  return `${part("year")}-${part("month")}-${part("day")}`
}

export function createInMemoryGatewayActivityStore(): GatewayActivityStore {
  const events = new Map<string, Awaited<ReturnType<GatewayActivityStore["record"]>>>()
  const attempts = new Map<string, import("./contract").RoutingAttemptEvent>()
  const outcomes = new Map<string, import("./contract").OutcomeAttribution>()
  return {
    async record({ tenantId, event }) {
      const previous = events.get(`${tenantId}:${event.correlation_id}`)
      const value = {
        ...previous,
        ...structuredClone(event),
        tenant_id: tenantId,
        subject_display: previous?.subject_display ?? null,
        cost_estimation_status: "NOT_APPLICABLE" as const,
        estimated_cost_currency: null,
        estimated_cost_micros: null,
        pricing_source: null,
        pricing_version: null,
        downstream_identity_mode: previous?.downstream_identity_mode ?? null,
        application_id: event.application_id ?? previous?.application_id ?? null,
        subject_id: event.subject_id ?? previous?.subject_id ?? null,
        acting_client_id: event.acting_client_id ?? previous?.acting_client_id ?? null,
        session_id: event.session_id ?? previous?.session_id ?? null,
        entitlement_id: event.entitlement_id ?? previous?.entitlement_id ?? null,
        requested_model_id: event.requested_model_id ?? previous?.requested_model_id ?? null,
        effective_model_id: event.effective_model_id ?? previous?.effective_model_id ?? null,
        provider_id: event.provider_id ?? previous?.provider_id ?? null,
        connection_id: event.connection_id ?? previous?.connection_id ?? null,
        route_mode: event.route_mode ?? previous?.route_mode ?? null,
        route_lease_id: event.route_lease_id ?? previous?.route_lease_id ?? null,
        route_lease_reused:
          event.route_lease_reused ?? previous?.route_lease_reused ?? null,
        provider_credential_profile_id:
          event.provider_credential_profile_id ?? previous?.provider_credential_profile_id ?? null,
        provider_credential_profile_revision:
          event.provider_credential_profile_revision ?? previous?.provider_credential_profile_revision ?? null,
        provider_credential_strategy_digest:
          event.provider_credential_strategy_digest ?? previous?.provider_credential_strategy_digest ?? null,
        routing_policy_id:
          event.routing_policy_id ?? previous?.routing_policy_id ?? null,
        routing_revision:
          event.routing_revision ?? previous?.routing_revision ?? null,
        candidate_set_digest:
          event.candidate_set_digest ?? previous?.candidate_set_digest ?? null,
        processor_bundle_revision:
          event.processor_bundle_revision ?? previous?.processor_bundle_revision ?? null,
        processor_request_steps: event.processor_request_steps.length > 0
          ? structuredClone(event.processor_request_steps)
          : previous?.processor_request_steps ?? [],
        processor_response_steps: event.processor_response_steps.length > 0
          ? structuredClone(event.processor_response_steps)
          : previous?.processor_response_steps ?? [],
        data_classifications: event.data_classifications.length > 0
          ? structuredClone(event.data_classifications)
          : previous?.data_classifications ?? [],
        input_tokens: Math.max(event.input_tokens ?? 0, previous?.input_tokens ?? 0),
        output_tokens: Math.max(event.output_tokens ?? 0, previous?.output_tokens ?? 0),
        total_tokens: Math.max(event.total_tokens ?? 0, previous?.total_tokens ?? 0),
      }
      events.set(`${tenantId}:${event.correlation_id}`, value)
      return structuredClone(value)
    },
    async list({ tenantId, limit }) {
      return [...events.values()]
        .filter((event) => event.tenant_id === tenantId)
        .sort((left, right) => right.occurred_at - left.occurred_at)
        .slice(0, limit)
        .map((event) => structuredClone(event))
    },
    async get({ tenantId, correlationId }) {
      const event = events.get(`${tenantId}:${correlationId}`)
      return event ? structuredClone(event) : null
    },
    async listSession({ tenantId, sessionId }) {
      return [...events.values()]
        .filter((event) => event.tenant_id === tenantId && event.session_id === sessionId)
        .sort((left, right) => left.occurred_at - right.occurred_at || left.correlation_id.localeCompare(right.correlation_id))
        .map((event) => structuredClone(event))
    },
    async recordOutcome({ tenantId, correlationId, recordedBySubjectId, value }) {
      if (!events.has(`${tenantId}:${correlationId}`)) throw new Error("ACTIVITY_NOT_FOUND")
      const key = `${tenantId}:${value.attribution_id}`
      const existing = outcomes.get(key)
      if (existing) {
        const matches = existing.correlation_id === correlationId &&
          existing.source === value.source &&
          existing.outcome_reference === value.outcome_reference &&
          existing.value === value.value &&
          existing.observed_at === value.observed_at &&
          existing.recorded_by_subject_id === recordedBySubjectId
        if (!matches) throw new Error("OUTCOME_ATTRIBUTION_CONFLICT")
        return structuredClone(existing)
      }
      const attribution = {
        ...structuredClone(value),
        tenant_id: tenantId,
        correlation_id: correlationId,
        recorded_by_subject_id: recordedBySubjectId,
        recorded_at: Math.floor(Date.now() / 1000),
      }
      outcomes.set(key, attribution)
      return structuredClone(attribution)
    },
    async listOutcomes({ tenantId, correlationId }) {
      return [...outcomes.values()]
        .filter((value) => value.tenant_id === tenantId && value.correlation_id === correlationId)
        .sort((left, right) => left.observed_at - right.observed_at || left.attribution_id.localeCompare(right.attribution_id))
        .map((value) => structuredClone(value))
    },
    async recordAttempt({ tenantId, event }) {
      const value = { ...structuredClone(event), tenant_id: tenantId }
      const key = `${tenantId}:${event.correlation_id}:${event.attempt_id}`
      const previous = attempts.get(key)
      if (previous && JSON.stringify(previous) !== JSON.stringify(value)) throw new Error("ROUTING_ATTEMPT_CONFLICT")
      attempts.set(key, value)
      return structuredClone(value)
    },
    async listAttempts({ tenantId, correlationId }) {
      return [...attempts.values()]
        .filter((attempt) => attempt.tenant_id === tenantId && attempt.correlation_id === correlationId)
        .sort((left, right) => left.order - right.order)
        .map((attempt) => structuredClone(attempt))
    },
    async trend({ tenantId, from, to, timeZone }) {
      const totals = new Map<string, {
        day: string
        enforcement_point_id: string
        outcome: Awaited<ReturnType<GatewayActivityStore["record"]>>["outcome"]
        count: number
      }>()
      for (const event of events.values()) {
        if (event.tenant_id !== tenantId || event.occurred_at < from || event.occurred_at > to) continue
        const day = localDay(event.occurred_at, timeZone)
        const key = `${day}\u0000${event.enforcement_point_id}\u0000${event.outcome}`
        const current = totals.get(key)
        if (current) current.count += 1
        else totals.set(key, {
          day,
          enforcement_point_id: event.enforcement_point_id,
          outcome: event.outcome,
          count: 1,
        })
      }
      return [...totals.values()].sort((left, right) =>
        `${left.day}:${left.enforcement_point_id}:${left.outcome}`.localeCompare(
          `${right.day}:${right.enforcement_point_id}:${right.outcome}`,
        )
      )
    },
    async summarize({ tenantId, from, to }) {
      return summarizeGatewayActivities({
        tenantId,
        from,
        to,
        events: [...events.values()].map((event) => ({ event })),
      })
    },
  }
}
