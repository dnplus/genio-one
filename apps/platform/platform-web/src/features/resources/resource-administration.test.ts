import assert from "node:assert/strict"
import test from "node:test"

import type { IdentitySession, RegisterConnectionInput } from "@/domain/contracts"
import {
  createResourceAdministration,
  publicationErrorDetails,
  resourceAdministrationState,
  type ResourceAdministrationOperations,
} from "@/features/resources/resource-administration"
import { ProductApiError } from "@/lib/product-api"
import { createMockOverview } from "@/mocks/overview"

function operations(
  overrides: Partial<ResourceAdministrationOperations>,
): ResourceAdministrationOperations {
  return {
    registerConnection: async () => { throw new Error("unexpected register") },
    verifyResourceConnection: async () => { throw new Error("unexpected verify") },
    addConnectionModelMapping: async () => { throw new Error("unexpected mapping") },
    createPublicModel: async () => { throw new Error("unexpected public model") },
    ensureStandardModelRoutingPolicy: async () => { throw new Error("unexpected routing") },
    saveStandardResourceEnforcement: async () => { throw new Error("unexpected enforcement") },
    requestResourcePublication: async () => { throw new Error("unexpected request") },
    reviewResourcePublication: async () => { throw new Error("unexpected review") },
    ...overrides,
  } as ResourceAdministrationOperations
}

test("Resource administration derives owner scope and publication readiness once", () => {
  const data = createMockOverview()
  const resource = data.resources.find((candidate) => candidate.owner_organization_id === "ai-platform")!
  const identity: IdentitySession = {
    tenant_id: resource.tenant_id,
    subject_id: "ai-owner",
    acting_client_id: "management-ui",
    role: "ORGANIZATION_ADMINISTRATOR",
    organization_ids: ["ai-platform"],
    scopes: ["genioone-management"],
    acr: "oidc",
    amr: ["oidc"],
  }

  const state = resourceAdministrationState({
    data,
    identity,
    isTenantAdministrator: false,
    resource,
  })

  assert.equal(state.canManageResource, true)
  assert.equal(state.canManageDraft, resource.lifecycle === "DRAFT" && !state.pendingPublication)
  assert.equal(state.canRequestPublication, ["DRAFT", "PUBLISHED"].includes(resource.lifecycle) && !state.pendingPublication)
  assert.equal(state.publicationBlocker === "CONNECTION_REQUIRED", !state.hasAvailableConnection)
})

test("publication requests allow managed Draft and Published Resources only when no review is pending", () => {
  const data = createMockOverview()
  const resource = data.resources.find((candidate) => candidate.owner_organization_id === "ai-platform")!
  const identity: IdentitySession = {
    tenant_id: resource.tenant_id,
    subject_id: "ai-owner",
    acting_client_id: "management-ui",
    role: "ORGANIZATION_ADMINISTRATOR",
    organization_ids: ["ai-platform"],
    scopes: ["genioone-management"],
    acr: "oidc",
    amr: ["oidc"],
  }
  const published = { ...resource, lifecycle: "PUBLISHED" as const, publication_request: null }
  const pending = {
    ...published,
    publication_request: { request_id: "request-1", state: "PENDING" as const, requested_by: "ai-owner", requested_at: 1, reviewed_by: null, reviewed_at: null, publication_state: "PENDING_REVIEW" as const, attempt_id: null, failure_code: null },
  }
  const retired = { ...published, lifecycle: "RETIRED" as const }
  const unauthorized = { ...identity, subject_id: "person-other", organization_ids: [] }

  assert.equal(resourceAdministrationState({ data, identity, isTenantAdministrator: false, resource: published }).canRequestPublication, true)
  assert.equal(resourceAdministrationState({ data, identity, isTenantAdministrator: false, resource: pending }).canRequestPublication, false)
  assert.equal(resourceAdministrationState({ data, identity, isTenantAdministrator: false, resource: retired }).canRequestPublication, false)
  assert.equal(resourceAdministrationState({ data, identity: unauthorized, isTenantAdministrator: false, resource: published }).canRequestPublication, false)
})

test("a failed publication build reopens draft inputs while review and build remain locked", () => {
  const data = createMockOverview()
  const resource = data.resources.find((candidate) => candidate.owner_organization_id === "ai-platform")!
  const identity: IdentitySession = {
    tenant_id: resource.tenant_id,
    subject_id: "ai-owner",
    acting_client_id: "management-ui",
    role: "ORGANIZATION_ADMINISTRATOR",
    organization_ids: ["ai-platform"],
    scopes: ["genioone-management"],
    acr: "oidc",
    amr: ["oidc"],
  }
  const reviewing = {
    ...resource,
    lifecycle: "DRAFT" as const,
    publication_request: { request_id: "request-1", state: "PENDING" as const, requested_by: "ai-owner", requested_at: 1, reviewed_by: null, reviewed_at: null, publication_state: "PENDING_REVIEW" as const, attempt_id: null, failure_code: null },
  }
  const failed = {
    ...reviewing,
    publication_request: { ...reviewing.publication_request, publication_state: "FAILED" as const, failure_code: "MCP_TOOL_SELECTION_REQUIRED" },
  }
  assert.equal(resourceAdministrationState({ data, identity, isTenantAdministrator: false, resource: reviewing }).canManageDraft, false)
  assert.equal(resourceAdministrationState({ data, identity, isTenantAdministrator: false, resource: failed }).canManageDraft, true)
})

test("Publication failures preserve API violations and expose unexpected errors", () => {
  const apiError = new ProductApiError("RESOURCE_NOT_PUBLISHABLE", 422, [{ code: "CONNECTION_NOT_READY", message: "Verify the selected Connection" }])
  const details = publicationErrorDetails(apiError)
  assert.deepEqual(details, {
    code: "RESOURCE_NOT_PUBLISHABLE",
    violations: [{ code: "CONNECTION_NOT_READY", message: "Verify the selected Connection" }],
  })

  const unexpected = publicationErrorDetails(new Error("BROWSER_OIDC_UNAVAILABLE"))
  assert.equal(unexpected.code, "BROWSER_OIDC_UNAVAILABLE")
  assert.deepEqual(unexpected.violations, [{ code: "BROWSER_OIDC_UNAVAILABLE", message: "BROWSER_OIDC_UNAVAILABLE" }])
})

test("Connection workflow reports the exact partial-failure stage and stops", async () => {
  const data = createMockOverview()
  const connection = data.connections[0]!
  const registeredConnection = {
    tenant_id: "tenant-design-preview",
    connection_id: connection.connection_id,
    resource_id: connection.resource_id,
    display_name: connection.display_name,
    connection_kind: "LLM" as const,
    provider_type: null,
    endpoint: connection.endpoint_url,
    status: "DRAFT" as const,
  }
  const calls: string[] = []
  const administration = createResourceAdministration(operations({
    registerConnection: async () => {
      calls.push("register")
      return registeredConnection
    },
    verifyResourceConnection: async () => {
      calls.push("verify")
      return { ...connection, configuration_revision: 7 }
    },
    addConnectionModelMapping: async () => {
      calls.push("map")
      throw new Error("mapping failed")
    },
  }))
  const input = {
    displayName: "Primary",
    kind: "LLM",
    endpointUrl: "https://provider.example/v1",
    resiliency: {
      timeout_ms: 30_000,
      max_attempts: 1,
      idempotency_header: null,
      circuit_failure_threshold: 5,
      circuit_open_ms: 30_000,
    },
    resourceId: connection.resource_id,
    enforcementPointId: "genio-ai-mcp-gateway",
  } satisfies RegisterConnectionInput

  const outcome = await administration.registerVerifiedConnection({
    tenantId: "tenant-design-preview",
    connection: input,
    mappings: [{ modelId: "model.invoke", providerModel: "provider-model" }],
  })

  assert.equal(outcome.status, "FAILED")
  if (outcome.status === "FAILED") {
    assert.equal(outcome.failedStage, "MAP_PUBLIC_MODEL")
    assert.deepEqual(outcome.completedStages, ["REGISTER_CONNECTION", "VERIFY_CONNECTION"])
  }
  assert.deepEqual(calls, ["register", "verify", "map"])
})

test("Standard publication preparation freezes inputs before request; approval only reviews that snapshot", async () => {
  const resource = createMockOverview().resources[0]!
  const calls: string[] = []
  const administration = createResourceAdministration(operations({
    ensureStandardModelRoutingPolicy: async () => { calls.push("routing") },
    saveStandardResourceEnforcement: async () => { calls.push("enforcement") },
    requestResourcePublication: async () => {
      calls.push("request")
      return { request_id: "publication-request-1" }
    },
    reviewResourcePublication: async () => {
      calls.push("approve")
      return resource
    },
  }))

  const outcome = await administration.requestPublication({
    tenantId: resource.tenant_id,
    resource,
    prepareStandardWorkflow: true,
    autoApprove: false,
  })

  assert.equal(outcome.status, "SUCCEEDED")
  const review = await administration.reviewPublication({
    tenantId: resource.tenant_id,
    resource,
    requestId: "publication-request-1",
    decision: "APPROVE",
  })
  assert.equal(review.status, "SUCCEEDED")
  assert.deepEqual(calls, ["routing", "enforcement", "request", "approve"])
})
