import grpc from "@grpc/grpc-js"
import { createClient } from "redis"

import { FileAuthorizationBundleStore } from "./bundle-store"
import {
  createExternalAuthorizerServer,
  type RoutingRejectionObservation,
  type UsageRejectionObservation,
} from "./grpc"
import type { AuthorizationDecisionEvent } from "@genioone/protocol/authorization"
import type { AuthorizationInput } from "@genioone/protocol/authorization"
import { policyReleaseLoaderOptionsFromEnvironment } from "../shared/policy-release"
import { startGatewaySidecarReadinessServer } from "../shared/release-readiness"
import { createValkeyExecutionGrantConsumer, createValkeyUsageCounterStore } from "../shared/usage-governance-valkey"
import type { GatewayActivityIngest } from "../shared/gateway-activity"

const listen = process.env.GENIO_ONE_AUTHORIZER_LISTEN ?? "0.0.0.0:8081"
const readinessListen =
  process.env.GENIO_ONE_AUTHORIZER_READINESS_LISTEN ?? "127.0.0.1:9081"
const observationOrigin = process.env.GENIO_ONE_GATEWAY_OBSERVATION_ORIGIN?.replace(/\/$/, "")
const valkeyOrigin = process.env.GENIO_ONE_VALKEY_ORIGIN
const separator = listen.lastIndexOf(":")
const host = listen.slice(0, separator)
const port = Number.parseInt(listen.slice(separator + 1), 10)

if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("GENIO_ONE_AUTHORIZER_LISTEN must be host:port")
}

const store = new FileAuthorizationBundleStore(
  {
    ...policyReleaseLoaderOptionsFromEnvironment(),
    authorityFloorPath: process.env.GENIO_ONE_AUTHORITY_FLOOR_FILE?.trim() || undefined,
  },
)
// The process may start before the supervisor establishes the first empty
// release. Readiness remains UNKNOWN and each authorization request still
// fails closed until CURRENT or LKG can be verified.
const readiness = await startGatewaySidecarReadinessServer(
  readinessListen,
  "AUTHORIZER",
  store,
)
const valkey = valkeyOrigin ? createClient({ url: valkeyOrigin }) : undefined
if (valkey) await valkey.connect()
function auditEvent(event: AuthorizationDecisionEvent) {
  const { input, decision } = event
  return {
    audit_event_id: decision.decisionId,
    correlation_id: input.correlationId,
    kind: "ONE_POLICY_DECISION",
    outcome: decision.disposition,
    subject: { subject_id: input.subjectId, evidence_level: "VERIFIED" },
    target_subject_id: null,
    actor_subject: null,
    acting_client: { acting_client_id: input.actingClientId, evidence_level: "VERIFIED" },
    resource_id: input.resourceId,
    capability_id: input.capabilityId,
    device_id: null,
    endpoint_version: null,
    desired_state_revision: null,
    applied_state_revision: null,
    applied_policy_version: decision.policyVersion,
    policy_proposal_id: null,
    proposed_policy_version: null,
    access_group_id: null,
    destination_host: null,
    routing_policy_rule_id: decision.ruleId ?? null,
    route: "MANAGED",
    missing_deployment_capability: null,
    decision: {
      decision_id: decision.decisionId,
      correlation_id: input.correlationId,
      policy_version: decision.policyVersion,
      winning_rule_id: decision.ruleId ?? null,
      reason: decision.reason,
      visibility: "VISIBLE",
      access: decision.disposition === "ALLOW" ? "ENTITLED" : "DENY",
      route: "MANAGED",
      obligations: [],
      entitlement_conditions: {
        required_verified_acting_client_id: input.actingClientId,
        requires_device: false,
      },
      entitlement_id: decision.ruleId ?? null,
      auto_grant_valid_for: null,
      input_receipt: {
        requested_model_id: input.requestedPublicModel ?? null,
        effective_model_id: input.requestedPublicModel ?? null,
        mcp_method: input.mcpMethod ?? null,
        mcp_tool: input.mcpTool ?? null,
        mcp_protocol_version: null,
        mcp_connection_id: null,
      },
      agent_authority: input.subjectKind === "AGENT" && (input.authorityMode === "SELF" || input.authorityMode === "DELEGATED") ? {
        authority_mode: input.authorityMode,
        agent_subject_id: input.subjectId,
        principal_subject_id: input.principalSubjectId ?? null,
        delegation_id: input.delegationId ?? null,
        delegation_revision: input.delegationRevision ?? null,
        delegation_revocation_generation: input.delegationRevocationGeneration ?? null,
        target_agent_subject_id: input.targetAgentSubjectId ?? null,
        execution_grant_id: input.executionGrantId ?? null,
        action_digest: input.actionDigest ?? null,
      } : null,
    },
    access_request_id: null,
    entitlement_id: decision.ruleId ?? null,
    enforcement_point_id: input.requestProtocol === "API" ? "API_GATEWAY" : "AI_GATEWAY",
    obligation_kind: null,
    runaway_trigger: null,
    upstream_attempted: false,
    occurred_at: input.now,
  }
}

async function resolveMcpOAuthHeaders(input: AuthorizationInput) {
  if (!observationOrigin) return []
  const url = new URL(`${observationOrigin}/mcp-oauth/headers`)
  url.searchParams.set("resource_id", input.resourceId)
  url.searchParams.set("subject_id", input.subjectId)
  if (input.mcpMethod) url.searchParams.set("mcp_method", input.mcpMethod)
  const response = await fetch(url, { headers: { accept: "application/json" } })
  if (!response.ok) throw new Error("MCP OAuth credential resolution failed")
  const body = await response.json() as { headers?: unknown }
  if (!Array.isArray(body.headers) || body.headers.length > 1024) {
    throw new Error("MCP OAuth credential response is invalid")
  }
  return body.headers.map((header) => {
    if (!header || typeof header !== "object" || Array.isArray(header)) {
      throw new Error("MCP OAuth credential response is invalid")
    }
    const value = header as { name?: unknown; value?: unknown }
    if (typeof value.name !== "string" || typeof value.value !== "string") {
      throw new Error("MCP OAuth credential response is invalid")
    }
    return { name: value.name, value: value.value }
  })
}

function usageRejectionActivity(event: UsageRejectionObservation): GatewayActivityIngest {
  const { input, authorizationDecision, releaseReference } = event
  return {
    correlation_id: input.correlationId,
    resource_id: input.resourceId,
    capability_id: input.capabilityId,
    application_id: null,
    subject_id: input.subjectId,
    acting_client_id: input.actingClientId,
    entitlement_id: authorizationDecision.ruleId ?? null,
    usage_admission_id: null,
    usage_admission_disposition: "REJECT",
    usage_admission_reason: event.reason,
    consumer_organization_id: input.consumerOrganizationId ?? null,
    resource_owner_organization_id: input.resourceOwnerOrganizationId ?? null,
    use_case_id: input.useCaseId ?? null,
    enforcement_point_id: input.requestProtocol === "API" ? "API_GATEWAY" : "AI_GATEWAY",
    route: "MANAGED",
    method: input.requestMethod ?? "POST",
    path: input.requestPath ?? "/",
    status_code: event.statusCode,
    outcome: event.statusCode === 429 ? "RATE_LIMITED" : "FAILED",
    error_code: event.reason,
    latency_millis: 0,
    upstream_attempted: false,
    requested_model_id: input.requestedPublicModel ?? null,
    effective_model_id: null,
    provider_id: null,
    connection_id: null,
    mcp_method: input.mcpMethod ?? null,
    mcp_tool: input.mcpTool ?? null,
    mcp_backend: null,
    processor_bundle_revision: null,
    processor_request_steps: [],
    processor_response_steps: [],
    data_classifications: [],
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    route_mode: null,
    route_lease_id: null,
    route_lease_reused: null,
    routing_policy_id: null,
    routing_revision: null,
    candidate_set_digest: null,
    candidate_connection_ids: [],
    release_id: releaseReference.release_id,
    release_head_revision: releaseReference.head_revision,
    detail_availability: "NOT_CAPTURED",
    detail_ref: null,
    detail_expires_at: null,
    occurred_at: input.now,
  }
}

async function deliverUsageRejection(event: UsageRejectionObservation) {
  if (!observationOrigin) return
  const response = await fetch(`${observationOrigin}/activities`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(usageRejectionActivity(event)),
  })
  if (!response.ok) throw new Error(`usage rejection activity delivery failed (${response.status})`)
}

function routingRejectionActivity(event: RoutingRejectionObservation): GatewayActivityIngest {
  const { input, authorizationDecision, releaseReference, routing } = event
  return {
    correlation_id: input.correlationId,
    resource_id: input.resourceId,
    capability_id: input.capabilityId,
    application_id: null,
    subject_id: input.subjectId,
    acting_client_id: input.actingClientId,
    entitlement_id: authorizationDecision.ruleId ?? null,
    usage_admission_id: null,
    usage_admission_disposition: "NOT_APPLICABLE",
    usage_admission_reason: null,
    consumer_organization_id: input.consumerOrganizationId ?? null,
    resource_owner_organization_id: input.resourceOwnerOrganizationId ?? null,
    use_case_id: input.useCaseId ?? null,
    enforcement_point_id: input.requestProtocol === "API" ? "API_GATEWAY" : "AI_GATEWAY",
    route: "MANAGED",
    method: input.requestMethod ?? "POST",
    path: input.requestPath ?? "/",
    status_code: event.statusCode,
    outcome: "FAILED",
    error_code: event.reason,
    latency_millis: 0,
    upstream_attempted: false,
    requested_model_id: input.requestedPublicModel ?? null,
    effective_model_id: null,
    provider_id: null,
    connection_id: null,
    mcp_method: input.mcpMethod ?? null,
    mcp_tool: input.mcpTool ?? null,
    mcp_backend: null,
    processor_bundle_revision: null,
    processor_request_steps: [],
    processor_response_steps: [],
    data_classifications: [],
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    route_mode: null,
    route_lease_id: null,
    route_lease_reused: null,
    routing_policy_id: routing.routing_policy_id,
    routing_revision: routing.routing_revision,
    candidate_set_digest: routing.candidate_set_digest,
    candidate_connection_ids: routing.candidate_connection_ids,
    release_id: releaseReference.release_id,
    release_head_revision: releaseReference.head_revision,
    detail_availability: "NOT_CAPTURED",
    detail_ref: null,
    detail_expires_at: null,
    occurred_at: input.now,
  }
}

async function deliverRoutingRejection(event: RoutingRejectionObservation) {
  if (!observationOrigin) return
  const response = await fetch(`${observationOrigin}/activities`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(routingRejectionActivity(event)),
  })
  if (!response.ok) throw new Error(`routing rejection activity delivery failed (${response.status})`)
}

const server = createExternalAuthorizerServer(store, async (event) => {
  process.stdout.write(`${JSON.stringify(event)}\n`)
  if (!observationOrigin) return
  const response = await fetch(`${observationOrigin}/audit-events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(auditEvent(event)),
  })
  if (!response.ok) throw new Error(`authorization audit delivery failed (${response.status})`)
}, resolveMcpOAuthHeaders, valkey ? createValkeyUsageCounterStore(valkey) : undefined, deliverUsageRejection, deliverRoutingRejection, valkey ? createValkeyExecutionGrantConsumer(valkey) : undefined)

try {
  await new Promise<void>((resolve, reject) => {
    server.bindAsync(listen, grpc.ServerCredentials.createInsecure(), (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
} catch (error) {
  await readiness.close()
  if (valkey?.isOpen) await valkey.quit()
  throw error
}

let stopping = false
const shutdown = () => {
  if (stopping) return
  stopping = true
  void (async () => {
    await readiness.close()
    if (valkey?.isOpen) await valkey.quit()
    await new Promise<void>((resolve) => server.tryShutdown(() => resolve()))
  })().catch(() => process.exitCode = 1)
}
process.once("SIGTERM", shutdown)
process.once("SIGINT", shutdown)
