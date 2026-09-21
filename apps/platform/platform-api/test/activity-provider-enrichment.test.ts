import assert from "node:assert/strict"
import test from "node:test"

import { createPostgresGatewayActivityStore } from "../src/capabilities/activities/postgres"
import type { GatewayActivityIngest } from "../src/capabilities/activities/contract"
import type { ConnectionRegistration } from "../src/capabilities/connections/contract"
import type { SqlAdapter } from "../src/persistence/sql-adapter"

test("Activity resolves the Provider from its trusted Resource Connection before estimating cost", async () => {
  const event: GatewayActivityIngest = {
    correlation_id: "correlation-1",
    resource_id: "resource-1",
    capability_id: "model.invoke",
    application_id: null,
    subject_id: "person-1",
    acting_client_id: "client-1",
    entitlement_id: "entitlement-1",
    usage_admission_id: "admission-1",
    usage_admission_disposition: "ADMIT",
    usage_admission_reason: null,
    consumer_organization_id: "organization-consumer",
    resource_owner_organization_id: "organization-owner",
    use_case_id: "use-case-1",
    enforcement_point_id: "AI_GATEWAY",
    route: "MANAGED",
    method: "POST",
    path: "/v1/chat/completions",
    status_code: 200,
    outcome: "COMPLETED",
    error_code: null,
    latency_millis: 25,
    upstream_attempted: true,
    requested_model_id: "genio-chat",
    effective_model_id: "local-model",
    provider_id: null,
    connection_id: "connection-1",
    mcp_method: null,
    mcp_tool: null,
    mcp_backend: null,
    processor_bundle_revision: "bundle-1",
    processor_request_steps: [{ step_id: "protect", action: "TOKENIZE" }],
    processor_response_steps: [{ step_id: "protect", action: "RESTORE" }],
    data_classifications: [{
      classification: "CUSTOMER_DATA",
      handling_action: "TOKENIZE",
      source: "DLP_DETECTOR",
      source_version: "policy-1",
      trust_level: "RUNTIME_OBSERVED",
      step_id: "protect",
    }],
    safety_decisions: [{
      adapter_id: "safety-system-one",
      provider: "JEV",
      model: "jev-latest",
      check_id: "prompt-injection",
      score: 0.92,
      threshold: 0.8,
      decision: "BLOCK",
      direction: "response",
      step_id: "protect",
    }],
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    route_mode: "SESSION_LEASE",
    route_lease_id: "route-lease-1",
    route_lease_reused: false,
    routing_policy_id: "routing-policy-1",
    routing_revision: 1,
    candidate_set_digest: "a".repeat(64),
    detail_availability: "NOT_CAPTURED",
    detail_ref: null,
    detail_expires_at: null,
    occurred_at: 1_700_000_000,
  }
  const connection: ConnectionRegistration = {
    tenant_id: "tenant-1",
    resource_id: event.resource_id,
    connection_id: event.connection_id!,
    display_name: "Local Ollama",
    connection_kind: "LLM",
    provider_type: "OLLAMA",
    provider_profile_id: "provider-ollama",
    endpoint: "http://127.0.0.1:11434/v1",
    mcp_selected_tools: [],
    mcp_tool_selection_operation_id: null,
    credential_ref: null,
    downstream_identity: { mode: "NONE" },
    request_mapping: null,
    status: "READY",
    configuration_revision: 1,
    lifecycle: "ENABLED",
    verification_state: "VERIFIED",
    health_state: "HEALTHY",
    health_observed_at: event.occurred_at,
    health_source_revision: 1,
    routing_priority: 0,
    region: null,
    supported_obligations: [],
    created_at: event.occurred_at,
  }
  let estimatorProvider: string | null | undefined
  let statement = ""
  const sql: SqlAdapter = {
    async query<Row extends Record<string, unknown>>(
      text: string,
      parameters: readonly unknown[] = [],
    ) {
      statement = text
      assert.equal(parameters[25], "OLLAMA")
      assert.equal(parameters[57], JSON.stringify(event.data_classifications))
      assert.equal(parameters[58], JSON.stringify(event.safety_decisions))
      return {
        rows: [{
          tenant_id: "tenant-1",
          ...event,
          provider_id: "OLLAMA",
          downstream_identity_mode: "NONE",
          cost_estimation_status: "UNPRICED",
          estimated_cost_currency: null,
          estimated_cost_micros: null,
          pricing_source: "LITELLM",
          pricing_version: "b".repeat(64),
        } as unknown as Row],
        rowCount: 1,
      }
    },
    async transaction() {
      throw new Error("transaction is not used by Activity record")
    },
  }
  const store = createPostgresGatewayActivityStore({
    sql,
    connections: {
      async list() {
        return []
      },
      async get(input) {
        assert.deepEqual(input, {
          tenantId: "tenant-1",
          resourceId: event.resource_id,
          connectionId: event.connection_id,
        })
        return connection
      },
    },
    costEstimator: {
      async estimate(input) {
        estimatorProvider = input.providerId
        return {
          status: "UNPRICED",
          currency: null,
          estimatedCostMicros: null,
          pricingSource: "LITELLM",
          pricingVersion: "b".repeat(64),
        }
      },
    },
  })

  const recorded = await store.record({ tenantId: "tenant-1", event })

  assert.equal(estimatorProvider, "OLLAMA")
  assert.equal(recorded.provider_id, "OLLAMA")
  assert.equal(recorded.downstream_identity_mode, "NONE")
  assert.equal(recorded.cost_estimation_status, "UNPRICED")
  assert.deepEqual(recorded.data_classifications, event.data_classifications)
  assert.deepEqual(recorded.safety_decisions, event.safety_decisions)
  assert.match(statement, /jsonb_array_elements\(genio_one_gateway_activities\.safety_decisions\) with ordinality/)
  assert.match(statement, /prior\.value ->> 'direction' = incoming\.value ->> 'direction'/)
  assert.match(statement, /prior\.value ->> 'step_id' = incoming\.value ->> 'step_id'/)
  assert.match(statement, /prior\.value ->> 'adapter_id' = incoming\.value ->> 'adapter_id'/)
  assert.match(statement, /prior\.value ->> 'check_id' = incoming\.value ->> 'check_id'/)
})

test("Activity inventory projects a canonical Subject display without exposing the Identity directory", async () => {
  let statement = ""
  const sql: SqlAdapter = {
    async query<Row extends Record<string, unknown>>(text: string) {
      statement = text
      return {
        rows: [{
          tenant_id: "tenant-1",
          correlation_id: "correlation-1",
          resource_id: "resource-1",
          capability_id: "model.invoke",
          application_id: "application-1",
          subject_id: "external-subject-1",
          canonical_subject_id: "person-1",
          subject_display_name: "Ada Lovelace",
          subject_kind: "PERSON",
          acting_client_id: "application-1",
          entitlement_id: "entitlement-1",
          usage_admission_id: "admission-1",
          usage_admission_disposition: "ADMIT",
          usage_admission_reason: null,
          consumer_organization_id: "organization-consumer",
          resource_owner_organization_id: "organization-owner",
          use_case_id: "use-case-1",
          enforcement_point_id: "AI_GATEWAY",
          route: "MANAGED",
          method: "POST",
          path: "/v1/chat/completions",
          status_code: 200,
          outcome: "COMPLETED",
          error_code: null,
          latency_millis: 25,
          upstream_attempted: true,
          requested_model_id: "genio-chat",
          effective_model_id: "local-model",
          provider_id: "OLLAMA",
          connection_id: "connection-1",
          downstream_identity_mode: "NONE",
          mcp_method: null,
          mcp_tool: null,
          mcp_backend: null,
          processor_bundle_revision: null,
          processor_request_steps: [],
          processor_response_steps: [],
          data_classifications: [],
          safety_decisions: [],
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          route_mode: "DETERMINISTIC",
          route_lease_id: null,
          route_lease_reused: null,
          routing_policy_id: null,
          routing_revision: null,
          candidate_set_digest: null,
          cost_estimation_status: "UNPRICED",
          estimated_cost_currency: null,
          estimated_cost_micros: null,
          pricing_source: "LITELLM",
          pricing_version: "b".repeat(64),
          detail_availability: "NOT_CAPTURED",
          detail_ref: null,
          detail_expires_at: null,
          occurred_at: 1_700_000_000,
        } as unknown as Row],
        rowCount: 1,
      }
    },
    async transaction() {
      throw new Error("transaction is not used by Activity inventory")
    },
  }
  const store = createPostgresGatewayActivityStore({
    sql,
    connections: {
      async list() { return [] },
      async get() { throw new Error("Connection lookup is not used by Activity inventory") },
    },
    costEstimator: {
      async estimate() {
        return {
          status: "NOT_APPLICABLE",
          currency: null,
          estimatedCostMicros: null,
          pricingSource: null,
          pricingVersion: null,
        }
      },
    },
  })

  const [activity] = await store.list({ tenantId: "tenant-1", limit: 10 })

  assert.match(statement, /genio_one_external_identity_bindings/)
  assert.match(statement, /genio_one_subjects/)
  assert.deepEqual(activity?.subject_display, {
    subject_id: "person-1",
    display_name: "Ada Lovelace",
    kind: "PERSON",
  })
})
