import { PlatformApiError } from "../errors"
import { boundedActivitySafetyDecisions, MAX_ACTIVITY_SAFETY_DECISIONS } from "./contract"
import type { SqlAdapter } from "../../persistence/sql-adapter"
import type { GatewayActivityEvent, GatewayActivityTrendPoint, OutcomeAttribution, RoutingAttemptEvent } from "./contract"
import type { GatewayActivityStore } from "./module"
import type { UsageCostEstimator } from "../pricing-catalog/module"
import type { ResourceConnectionRegistry } from "../connections/module"
import { summarizeGatewayActivities } from "./usage-summary"

interface GatewayActivityRow extends Record<string, unknown> {
  tenant_id: string
  correlation_id: string
  resource_id: string
  capability_id: string | null
  application_id: string | null
  subject_id: string | null
  canonical_subject_id?: string | null
  subject_display_name?: string | null
  subject_kind?: "PERSON" | "APPLICATION" | "AGENT" | null
  acting_client_id: string | null
  session_id?: string | null
  entitlement_id: string | null
  usage_admission_id: string | null
  usage_admission_disposition: GatewayActivityEvent["usage_admission_disposition"]
  usage_admission_reason: GatewayActivityEvent["usage_admission_reason"]
  consumer_organization_id: string | null
  resource_owner_organization_id: string | null
  use_case_id: string | null
  enforcement_point_id: string
  route: "MANAGED"
  method: string
  path: string
  status_code: number
  outcome: GatewayActivityEvent["outcome"]
  error_code: string | null
  latency_millis: number | string | null
  upstream_attempted: boolean
  requested_model_id: string | null
  effective_model_id: string | null
  provider_id: string | null
  connection_id: string | null
  downstream_identity_mode: "NONE" | "SERVICE" | "USER_PASSTHROUGH" | "USER_OAUTH" | null
  mcp_method: string | null
  mcp_tool: string | null
  mcp_backend: string | null
  processor_bundle_revision: string | null
  processor_request_steps: GatewayActivityEvent["processor_request_steps"]
  processor_response_steps: GatewayActivityEvent["processor_response_steps"]
  data_classifications?: GatewayActivityEvent["data_classifications"]
  safety_decisions?: GatewayActivityEvent["safety_decisions"]
  input_tokens: number | string | null
  output_tokens: number | string | null
  total_tokens: number | string | null
  route_mode: GatewayActivityEvent["route_mode"]
  route_lease_id: string | null
  route_lease_reused: boolean | null
  provider_credential_profile_id?: string | null
  provider_credential_profile_revision?: number | string | null
  provider_credential_strategy_digest?: string | null
  routing_policy_id: string | null
  routing_revision: number | string | null
  candidate_set_digest: string | null
  candidate_connection_ids?: string[]
  release_id?: string | null
  release_head_revision?: number | string | null
  cost_estimation_status: GatewayActivityEvent["cost_estimation_status"]
  estimated_cost_currency: "USD" | null
  estimated_cost_micros: number | string | null
  pricing_source: "LITELLM" | null
  pricing_version: string | null
  detail_availability: GatewayActivityEvent["detail_availability"]
  detail_ref: string | null
  detail_expires_at: number | string | null
  occurred_at: number | string
}

interface GatewayActivityUsageRow extends GatewayActivityRow {
  resource_display_name: string
}

interface GatewayActivityTrendRow extends Record<string, unknown> {
  day: string
  enforcement_point_id: string
  outcome: GatewayActivityEvent["outcome"]
  count: number | string
}

function integer(value: number | string): number {
  const normalized = Number(value)
  if (!Number.isSafeInteger(normalized)) throw new Error("Gateway activity timestamp is invalid")
  return normalized
}

function mapRow(row: GatewayActivityRow): GatewayActivityEvent {
  return {
    ...row,
    subject_display: row.canonical_subject_id && row.subject_display_name && row.subject_kind
      ? {
          subject_id: row.canonical_subject_id,
          display_name: row.subject_display_name,
          kind: row.subject_kind,
        }
      : null,
    latency_millis: row.latency_millis === null ? null : integer(row.latency_millis),
    input_tokens: row.input_tokens === null ? null : integer(row.input_tokens),
    output_tokens: row.output_tokens === null ? null : integer(row.output_tokens),
    total_tokens: row.total_tokens === null ? null : integer(row.total_tokens),
    routing_revision: row.routing_revision === null ? null : integer(row.routing_revision),
    provider_credential_profile_id: row.provider_credential_profile_id ?? null,
    provider_credential_profile_revision: row.provider_credential_profile_revision == null
      ? null
      : integer(row.provider_credential_profile_revision),
    provider_credential_strategy_digest: row.provider_credential_strategy_digest ?? null,
    data_classifications: row.data_classifications ?? [],
    safety_decisions: row.safety_decisions ?? [],
    candidate_connection_ids: row.candidate_connection_ids ?? [],
    release_id: row.release_id ?? null,
    release_head_revision: row.release_head_revision == null ? null : integer(row.release_head_revision),
    estimated_cost_micros: row.estimated_cost_micros === null ? null : integer(row.estimated_cost_micros),
    detail_expires_at: row.detail_expires_at === null ? null : integer(row.detail_expires_at),
    occurred_at: integer(row.occurred_at),
  }
}

function mapAttempt(row: Record<string, unknown>): RoutingAttemptEvent {
  return {
    tenant_id: String(row.tenant_id),
    correlation_id: String(row.correlation_id),
    attempt_id: String(row.attempt_id),
    order: integer(row.attempt_order as number | string),
    connection_id: String(row.connection_id),
    connection_configuration_revision: integer(row.connection_configuration_revision as number | string),
    priority: integer(row.priority as number | string),
    outcome: row.outcome as RoutingAttemptEvent["outcome"],
    response_started: Boolean(row.response_started),
    occurred_at: integer(row.occurred_at as number | string),
  }
}

function mapOutcome(row: Record<string, unknown>): OutcomeAttribution {
  return {
    tenant_id: String(row.tenant_id),
    attribution_id: String(row.attribution_id),
    correlation_id: String(row.correlation_id),
    source: String(row.source),
    outcome_reference: String(row.outcome_reference),
    value: String(row.value),
    observed_at: integer(row.observed_at as number | string),
    recorded_by_subject_id: String(row.recorded_by_subject_id),
    recorded_at: integer(row.recorded_at as number | string),
  }
}

export function createPostgresGatewayActivityStore(options: {
  sql: SqlAdapter
  costEstimator: UsageCostEstimator
  connections: Pick<ResourceConnectionRegistry, "get" | "list">
}): GatewayActivityStore {
  return {
    async recordAttempt({ tenantId, event }) {
      const result = await options.sql.query<Record<string, unknown>>(
        `insert into genio_one_routing_attempt_events
          (tenant_id, correlation_id, attempt_id, attempt_order, connection_id,
           connection_configuration_revision, priority, outcome, response_started, occurred_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,to_timestamp($10))
         on conflict (tenant_id, correlation_id, attempt_id) do update set
           attempt_id = excluded.attempt_id
         where genio_one_routing_attempt_events.attempt_order = excluded.attempt_order
           and genio_one_routing_attempt_events.connection_id = excluded.connection_id
           and genio_one_routing_attempt_events.connection_configuration_revision = excluded.connection_configuration_revision
           and genio_one_routing_attempt_events.priority = excluded.priority
           and genio_one_routing_attempt_events.outcome = excluded.outcome
           and genio_one_routing_attempt_events.response_started = excluded.response_started
         returning tenant_id, correlation_id, attempt_id, attempt_order, connection_id,
                   connection_configuration_revision, priority, outcome, response_started,
                   extract(epoch from occurred_at)::bigint as occurred_at`,
        [tenantId, event.correlation_id, event.attempt_id, event.order, event.connection_id,
          event.connection_configuration_revision, event.priority, event.outcome,
          event.response_started, event.occurred_at],
      )
      if (!result.rows[0]) throw new Error("ROUTING_ATTEMPT_CONFLICT")
      return mapAttempt(result.rows[0])
    },
    async listAttempts({ tenantId, correlationId }) {
      const result = await options.sql.query<Record<string, unknown>>(
        `select tenant_id, correlation_id, attempt_id, attempt_order, connection_id,
                connection_configuration_revision, priority, outcome, response_started,
                extract(epoch from occurred_at)::bigint as occurred_at
           from genio_one_routing_attempt_events
          where tenant_id = $1 and correlation_id = $2
          order by attempt_order`,
        [tenantId, correlationId],
      )
      return result.rows.map(mapAttempt)
    },
    async record({ tenantId, event }) {
      const safetyDecisions = boundedActivitySafetyDecisions([], event.safety_decisions ?? [])
      const inferredConnection = !event.connection_id && event.mcp_backend
        ? (await options.connections.list({
            tenantId,
            resourceId: event.resource_id,
          })).find((connection) =>
            connection.connection_kind === "MCP" &&
            connection.mcp_tool_namespace === event.mcp_backend
          )
        : undefined
      const connectionId = event.connection_id ?? inferredConnection?.connection_id ?? null
      const connection = connectionId
        ? await options.connections.get({
            tenantId,
            resourceId: event.resource_id,
            connectionId,
          })
        : null
      const providerId = connection?.provider_type ?? event.provider_id
      const downstreamIdentityMode = connection?.downstream_identity.mode ?? null
      const estimate = await options.costEstimator.estimate({
        providerId,
        effectiveModelId: event.effective_model_id,
        inputTokens: event.input_tokens,
        outputTokens: event.output_tokens,
        totalTokens: event.total_tokens,
      })
      const result = await options.sql.query<GatewayActivityRow>(
        `insert into genio_one_gateway_activities (
          tenant_id, correlation_id, resource_id, capability_id, application_id,
          subject_id, acting_client_id, entitlement_id,
          usage_admission_id, usage_admission_disposition, usage_admission_reason,
          consumer_organization_id, resource_owner_organization_id, use_case_id,
          enforcement_point_id,
          route, method, path, status_code, outcome, error_code, latency_millis,
          upstream_attempted, requested_model_id, effective_model_id, provider_id,
          connection_id, downstream_identity_mode, mcp_method, mcp_tool, mcp_backend,
          processor_bundle_revision, processor_request_steps, processor_response_steps,
          input_tokens, output_tokens, total_tokens,
          route_mode, route_lease_id, route_lease_reused, routing_policy_id,
          routing_revision, candidate_set_digest, candidate_connection_ids,
          release_id, release_head_revision,
          cost_estimation_status, estimated_cost_currency, estimated_cost_micros,
          pricing_source, pricing_version,
          detail_availability, detail_ref, detail_expires_at,
          provider_credential_profile_id, provider_credential_profile_revision,
          provider_credential_strategy_digest, data_classifications, safety_decisions, session_id, occurred_at
        ) values (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33::text::jsonb,$34::text::jsonb,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44::text[],$45,$46,$47,$48,$49,$50,$51,$52,$53,$54,$55,$56,$57,$58::text::jsonb,$59::text::jsonb,$60,$61
        ) on conflict (tenant_id, correlation_id) do update set
          capability_id = coalesce(excluded.capability_id, genio_one_gateway_activities.capability_id),
          application_id = coalesce(excluded.application_id, genio_one_gateway_activities.application_id),
          subject_id = coalesce(excluded.subject_id, genio_one_gateway_activities.subject_id),
          acting_client_id = coalesce(excluded.acting_client_id, genio_one_gateway_activities.acting_client_id),
          entitlement_id = coalesce(excluded.entitlement_id, genio_one_gateway_activities.entitlement_id),
          usage_admission_id = coalesce(excluded.usage_admission_id, genio_one_gateway_activities.usage_admission_id),
          usage_admission_disposition = case
            when excluded.usage_admission_disposition <> 'NOT_APPLICABLE' then excluded.usage_admission_disposition
            else genio_one_gateway_activities.usage_admission_disposition
          end,
          usage_admission_reason = coalesce(excluded.usage_admission_reason, genio_one_gateway_activities.usage_admission_reason),
          consumer_organization_id = coalesce(excluded.consumer_organization_id, genio_one_gateway_activities.consumer_organization_id),
          resource_owner_organization_id = coalesce(excluded.resource_owner_organization_id, genio_one_gateway_activities.resource_owner_organization_id),
          use_case_id = coalesce(excluded.use_case_id, genio_one_gateway_activities.use_case_id),
          session_id = coalesce(excluded.session_id, genio_one_gateway_activities.session_id),
          path = case
            when excluded.path <> '/' then excluded.path
            else genio_one_gateway_activities.path
          end,
          status_code = excluded.status_code,
          outcome = excluded.outcome,
          error_code = excluded.error_code,
          latency_millis = greatest(excluded.latency_millis, genio_one_gateway_activities.latency_millis),
          upstream_attempted = excluded.upstream_attempted or genio_one_gateway_activities.upstream_attempted,
          requested_model_id = coalesce(excluded.requested_model_id, genio_one_gateway_activities.requested_model_id),
          effective_model_id = coalesce(excluded.effective_model_id, genio_one_gateway_activities.effective_model_id),
          provider_id = coalesce(excluded.provider_id, genio_one_gateway_activities.provider_id),
          connection_id = coalesce(excluded.connection_id, genio_one_gateway_activities.connection_id),
          downstream_identity_mode = coalesce(excluded.downstream_identity_mode, genio_one_gateway_activities.downstream_identity_mode),
          mcp_method = coalesce(excluded.mcp_method, genio_one_gateway_activities.mcp_method),
          mcp_tool = coalesce(excluded.mcp_tool, genio_one_gateway_activities.mcp_tool),
          mcp_backend = coalesce(excluded.mcp_backend, genio_one_gateway_activities.mcp_backend),
          processor_bundle_revision = coalesce(excluded.processor_bundle_revision, genio_one_gateway_activities.processor_bundle_revision),
          processor_request_steps = case
            when jsonb_array_length(excluded.processor_request_steps) > 0 then excluded.processor_request_steps
            else genio_one_gateway_activities.processor_request_steps
          end,
          processor_response_steps = case
            when jsonb_array_length(excluded.processor_response_steps) > 0 then excluded.processor_response_steps
            else genio_one_gateway_activities.processor_response_steps
          end,
          data_classifications = case
            when jsonb_array_length(excluded.data_classifications) > 0 then excluded.data_classifications
            else genio_one_gateway_activities.data_classifications
          end,
          safety_decisions = case
            when jsonb_array_length(excluded.safety_decisions) > 0 and jsonb_array_length(genio_one_gateway_activities.safety_decisions) > 0 then (
              select coalesce(jsonb_agg(merged.decision order by merged.ordinality), '[]'::jsonb)
              from (
                select prior.value as decision, prior.ordinality
                from jsonb_array_elements(genio_one_gateway_activities.safety_decisions) with ordinality as prior(value, ordinality)
                union all
                select incoming.value as decision, 4096 + incoming.ordinality
                from jsonb_array_elements(excluded.safety_decisions) with ordinality as incoming(value, ordinality)
                where not exists (
                  select 1
                  from jsonb_array_elements(genio_one_gateway_activities.safety_decisions) as prior(value)
                  where prior.value ->> 'direction' = incoming.value ->> 'direction'
                    and prior.value ->> 'step_id' = incoming.value ->> 'step_id'
                    and prior.value ->> 'adapter_id' = incoming.value ->> 'adapter_id'
                    and prior.value ->> 'check_id' = incoming.value ->> 'check_id'
                )
              ) as merged
            )
            when jsonb_array_length(excluded.safety_decisions) > 0 then excluded.safety_decisions
            else genio_one_gateway_activities.safety_decisions
          end,
          input_tokens = greatest(coalesce(excluded.input_tokens, 0), coalesce(genio_one_gateway_activities.input_tokens, 0)),
          output_tokens = greatest(coalesce(excluded.output_tokens, 0), coalesce(genio_one_gateway_activities.output_tokens, 0)),
          total_tokens = greatest(coalesce(excluded.total_tokens, 0), coalesce(genio_one_gateway_activities.total_tokens, 0)),
          route_mode = coalesce(excluded.route_mode, genio_one_gateway_activities.route_mode),
          route_lease_id = coalesce(excluded.route_lease_id, genio_one_gateway_activities.route_lease_id),
          route_lease_reused = coalesce(excluded.route_lease_reused, genio_one_gateway_activities.route_lease_reused),
          provider_credential_profile_id = coalesce(excluded.provider_credential_profile_id, genio_one_gateway_activities.provider_credential_profile_id),
          provider_credential_profile_revision = coalesce(excluded.provider_credential_profile_revision, genio_one_gateway_activities.provider_credential_profile_revision),
          provider_credential_strategy_digest = coalesce(excluded.provider_credential_strategy_digest, genio_one_gateway_activities.provider_credential_strategy_digest),
          routing_policy_id = coalesce(excluded.routing_policy_id, genio_one_gateway_activities.routing_policy_id),
          routing_revision = coalesce(excluded.routing_revision, genio_one_gateway_activities.routing_revision),
          candidate_set_digest = coalesce(excluded.candidate_set_digest, genio_one_gateway_activities.candidate_set_digest),
          candidate_connection_ids = case when cardinality(excluded.candidate_connection_ids) > 0 then excluded.candidate_connection_ids else genio_one_gateway_activities.candidate_connection_ids end,
          release_id = coalesce(excluded.release_id, genio_one_gateway_activities.release_id),
          release_head_revision = coalesce(excluded.release_head_revision, genio_one_gateway_activities.release_head_revision),
          cost_estimation_status = case
            when excluded.cost_estimation_status <> 'NOT_APPLICABLE' then excluded.cost_estimation_status
            else genio_one_gateway_activities.cost_estimation_status
          end,
          estimated_cost_currency = coalesce(excluded.estimated_cost_currency, genio_one_gateway_activities.estimated_cost_currency),
          estimated_cost_micros = coalesce(excluded.estimated_cost_micros, genio_one_gateway_activities.estimated_cost_micros),
          pricing_source = coalesce(excluded.pricing_source, genio_one_gateway_activities.pricing_source),
          pricing_version = coalesce(excluded.pricing_version, genio_one_gateway_activities.pricing_version),
          occurred_at = excluded.occurred_at
        where jsonb_array_length(genio_one_gateway_activities.safety_decisions) + (
          select count(*)
          from jsonb_array_elements(excluded.safety_decisions) as incoming(value)
          where not exists (
            select 1
            from jsonb_array_elements(genio_one_gateway_activities.safety_decisions) as prior(value)
            where prior.value ->> 'direction' = incoming.value ->> 'direction'
              and prior.value ->> 'step_id' = incoming.value ->> 'step_id'
              and prior.value ->> 'adapter_id' = incoming.value ->> 'adapter_id'
              and prior.value ->> 'check_id' = incoming.value ->> 'check_id'
          )
        ) <= ${MAX_ACTIVITY_SAFETY_DECISIONS}
        returning *`,
        [tenantId, event.correlation_id, event.resource_id, event.capability_id,
          event.application_id, event.subject_id, event.acting_client_id,
          event.entitlement_id, event.usage_admission_id, event.usage_admission_disposition,
          event.usage_admission_reason, event.consumer_organization_id,
          event.resource_owner_organization_id, event.use_case_id,
          event.enforcement_point_id, event.route, event.method,
          event.path, event.status_code, event.outcome, event.error_code,
          event.latency_millis, event.upstream_attempted, event.requested_model_id,
          event.effective_model_id, providerId, connectionId, downstreamIdentityMode,
          event.mcp_method, event.mcp_tool, event.mcp_backend,
          event.processor_bundle_revision, JSON.stringify(event.processor_request_steps),
          JSON.stringify(event.processor_response_steps),
          event.input_tokens, event.output_tokens, event.total_tokens,
          event.route_mode, event.route_lease_id, event.route_lease_reused,
          event.routing_policy_id, event.routing_revision, event.candidate_set_digest,
          event.candidate_connection_ids ?? [], event.release_id ?? null,
          event.release_head_revision ?? null,
          estimate.status, estimate.currency, estimate.estimatedCostMicros,
          estimate.pricingSource, estimate.pricingVersion,
          event.detail_availability, event.detail_ref, event.detail_expires_at,
          event.provider_credential_profile_id ?? null,
          event.provider_credential_profile_revision ?? null,
          event.provider_credential_strategy_digest ?? null,
          JSON.stringify(event.data_classifications),
          JSON.stringify(safetyDecisions),
          event.session_id ?? null,
          event.occurred_at],
      )
      if (!result.rows[0]) throw new PlatformApiError("SAFETY_DECISION_RECEIPT_LIMIT_EXCEEDED", 422)
      return mapRow(result.rows[0])
    },
    async list({ tenantId, limit }) {
      const result = await options.sql.query<GatewayActivityRow>(
        `select
           activity.*,
           subject.subject_id as canonical_subject_id,
           coalesce(subject.display_name, subject.email, subject.subject_id) as subject_display_name,
           subject.kind as subject_kind
         from genio_one_gateway_activities activity
         left join lateral (
           select binding.subject_id
           from genio_one_external_identity_bindings binding
           where binding.tenant_id = activity.tenant_id
             and binding.external_subject_id = activity.subject_id
           order by binding.provider_id
           limit 1
         ) external_identity on true
         left join genio_one_subjects subject
           on subject.tenant_id = activity.tenant_id
          and subject.subject_id = coalesce(external_identity.subject_id, activity.subject_id)
         where activity.tenant_id = $1
         order by activity.occurred_at desc, activity.correlation_id desc
         limit $2`,
        [tenantId, limit],
      )
      return result.rows.map(mapRow)
    },
    async get({ tenantId, correlationId }) {
      const result = await options.sql.query<GatewayActivityRow>(
        `select activity.*,
                subject.subject_id as canonical_subject_id,
                coalesce(subject.display_name, subject.email, subject.subject_id) as subject_display_name,
                subject.kind as subject_kind
           from genio_one_gateway_activities activity
           left join genio_one_subjects subject
             on subject.tenant_id = activity.tenant_id
            and subject.subject_id = activity.subject_id
          where activity.tenant_id = $1 and activity.correlation_id = $2`,
        [tenantId, correlationId],
      )
      return result.rows[0] ? mapRow(result.rows[0]) : null
    },
    async listSession({ tenantId, sessionId }) {
      const result = await options.sql.query<GatewayActivityRow>(
        `select activity.*,
                subject.subject_id as canonical_subject_id,
                coalesce(subject.display_name, subject.email, subject.subject_id) as subject_display_name,
                subject.kind as subject_kind
           from genio_one_gateway_activities activity
           left join genio_one_subjects subject
             on subject.tenant_id = activity.tenant_id
            and subject.subject_id = activity.subject_id
          where activity.tenant_id = $1 and activity.session_id = $2
          order by activity.occurred_at, activity.correlation_id`,
        [tenantId, sessionId],
      )
      return result.rows.map(mapRow)
    },
    async recordOutcome({ tenantId, correlationId, recordedBySubjectId, value }) {
      const result = await options.sql.query<Record<string, unknown>>(
        `insert into genio_one_activity_outcome_attributions
          (tenant_id, attribution_id, correlation_id, source, outcome_reference,
           value, observed_at, recorded_by_subject_id, recorded_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         on conflict (tenant_id, attribution_id) do update set
           attribution_id = excluded.attribution_id
         where genio_one_activity_outcome_attributions.correlation_id = excluded.correlation_id
           and genio_one_activity_outcome_attributions.source = excluded.source
           and genio_one_activity_outcome_attributions.outcome_reference = excluded.outcome_reference
           and genio_one_activity_outcome_attributions.value = excluded.value
           and genio_one_activity_outcome_attributions.observed_at = excluded.observed_at
           and genio_one_activity_outcome_attributions.recorded_by_subject_id = excluded.recorded_by_subject_id
         returning tenant_id, attribution_id, correlation_id, source, outcome_reference,
                   value, observed_at, recorded_by_subject_id, recorded_at`,
        [tenantId, value.attribution_id, correlationId, value.source,
          value.outcome_reference, value.value, value.observed_at,
          recordedBySubjectId, Math.floor(Date.now() / 1000)],
      )
      if (!result.rows[0]) throw new Error("OUTCOME_ATTRIBUTION_CONFLICT")
      return mapOutcome(result.rows[0])
    },
    async listOutcomes({ tenantId, correlationId }) {
      const result = await options.sql.query<Record<string, unknown>>(
        `select tenant_id, attribution_id, correlation_id, source, outcome_reference,
                value, observed_at, recorded_by_subject_id, recorded_at
           from genio_one_activity_outcome_attributions
          where tenant_id = $1 and correlation_id = $2
          order by observed_at, attribution_id`,
        [tenantId, correlationId],
      )
      return result.rows.map(mapOutcome)
    },
    async trend({ tenantId, from, to, timeZone }) {
      const result = await options.sql.query<GatewayActivityTrendRow>(
        `select
           to_char(to_timestamp(occurred_at) at time zone $4, 'YYYY-MM-DD') as day,
           enforcement_point_id,
           outcome,
           count(*) as count
         from genio_one_gateway_activities
         where tenant_id = $1
           and occurred_at between $2 and $3
         group by 1, 2, 3
         order by 1 asc, 2 asc, 3 asc`,
        [tenantId, from, to, timeZone],
      )
      return result.rows.map((row): GatewayActivityTrendPoint => ({
        day: row.day,
        enforcement_point_id: row.enforcement_point_id,
        outcome: row.outcome,
        count: integer(row.count),
      }))
    },
    async summarize({ tenantId, from, to }) {
      const result = await options.sql.query<GatewayActivityUsageRow>(
        `select activity.*, resource.display_name as resource_display_name
         from genio_one_gateway_activities activity
         join genio_one_resources resource
           on resource.tenant_id = activity.tenant_id
          and resource.resource_id = activity.resource_id
         where activity.tenant_id = $1
           and activity.occurred_at between $2 and $3
         order by activity.occurred_at asc, activity.correlation_id asc`,
        [tenantId, from, to],
      )
      return summarizeGatewayActivities({
        tenantId,
        from,
        to,
        events: result.rows.map((row) => ({
          event: mapRow(row),
          resourceDisplayName: row.resource_display_name,
        })),
      })
    },
  }
}
