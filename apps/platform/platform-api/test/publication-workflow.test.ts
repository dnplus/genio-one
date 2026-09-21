import assert from "node:assert/strict"
import test from "node:test"

import { PlatformApiError } from "../src/capabilities/errors"
import { createEnforcementChainCompiler } from "../src/capabilities/enforcement/compiler"
import type {
  CompiledEnforcementChain,
  NativeJwtAuthenticationConfig,
} from "../src/capabilities/enforcement/contract"
import type { EnforcementChainRevision } from "../src/capabilities/enforcement/module"
import { createInMemoryResourceConnectionRegistry } from "../src/capabilities/connections/memory"
import { createInMemoryGatewayProjector } from "../src/capabilities/gateway-projection/memory"
import type { GatewayProjector } from "../src/capabilities/gateway-projection/module"
import {
  createAiResourcePublicationWorkflow,
  createInMemoryPublicationWorkflowStore,
} from "../src/capabilities/publications/memory"
import { createInMemoryEnforcementChainReader } from "../src/capabilities/enforcement/memory"
import type { EnforcementChainReader, PublicationWorkflowStore } from "../src/capabilities/publications/module"
import type { GatewayAggregatePublicationDelivery } from "../src/capabilities/gateway-policy-release/memory-delivery"
import { createModelMemoryState } from "../src/capabilities/models/state"
import { createInMemoryPublicModelCatalog } from "../src/capabilities/models/memory"
import { createInMemoryOrganizationDirectory } from "../src/capabilities/organizations/memory"
import { createInMemoryProviderProfileCatalog } from "../src/capabilities/providers/memory"
import { createInMemoryResourceRegistry } from "../src/capabilities/resources/memory"
import type { ResourceRegistration } from "../src/capabilities/resources/contract"
import { createResourceMemoryState } from "../src/capabilities/resources/state"

const tenantId = "tenant-acme"
const capabilityId = "chat"
const now = () => 1_700_000_000

const jwtConfig: NativeJwtAuthenticationConfig = {
  schema_version: "genio.one.auth.jwt.v1",
  provider: "test-oidc",
  issuer: "https://issuer.example.test",
  audiences: ["genio-one"],
  remote_jwks_uri: "https://issuer.example.test/.well-known/jwks.json",
  subject_claim: "sub",
  client_claim: "azp",
}

const signer = {
  algorithm: "Ed25519" as const,
  keyId: "test-signer-v1",
  sign: () => "A".repeat(86),
}

interface Fixture {
  resources: ReturnType<typeof createInMemoryResourceRegistry>
  connections: ReturnType<typeof createInMemoryResourceConnectionRegistry>
  models: ReturnType<typeof createInMemoryPublicModelCatalog>
  modelState: ReturnType<typeof createModelMemoryState>
  state: ReturnType<typeof createResourceMemoryState>
  chains: ReturnType<typeof createInMemoryEnforcementChainReader>
  compiler: ReturnType<typeof createEnforcementChainCompiler>
  store: PublicationWorkflowStore
  workflow: ReturnType<typeof createAiResourcePublicationWorkflow>
  resource: ResourceRegistration
  connectionId: string
}

async function createFixture(
  projector?: GatewayProjector,
  onBuildClaimed?: () => void | Promise<void>,
  gatewayDelivery?: GatewayAggregatePublicationDelivery,
): Promise<Fixture> {
  const organizations = createInMemoryOrganizationDirectory({ now })
  const organization = await organizations.create({
    tenantId,
    display_name: "Acme AI",
    slug: "acme-ai",
  })
  const state = createResourceMemoryState()
  const resources = createInMemoryResourceRegistry({ state, organizations, now })
  const providers = createInMemoryProviderProfileCatalog({ now })
  const connections = createInMemoryResourceConnectionRegistry({
    state,
    resources,
    providers,
    now,
    verifier: { verify: async () => true },
  })
  const modelState = createModelMemoryState()
  const models = createInMemoryPublicModelCatalog({
    state: modelState,
    resources,
    connections,
    providers,
    now,
  })

  const resource = await resources.createResource({
    tenantId,
    value: {
      display_name: "Corporate GPT",
      kind: "LLM",
      owner_organization_id: organization.organization_id,
      authentication_strategy: "OAUTH",
      environment_id: "local",
      version: "1.0.0",
      capabilities: [{ capability_id: capabilityId, display_name: "Chat" }],
      enforcement_point_id: "ai-gateway",
    },
  })
  const connection = await connections.create({
    tenantId,
    resourceId: resource.resource_id,
    value: {
      display_name: "Ollama local",
      provider_type: "OLLAMA",
      provider_profile_id: "provider-ollama",
      endpoint: "http://127.0.0.1:11434/v1",
    },
  })
  const readyConnection = await (connections as typeof connections & {
    verify(input: { tenantId: string; resourceId: string; connectionId: string }): Promise<unknown>
  }).verify({
    tenantId,
    resourceId: resource.resource_id,
    connectionId: connection.connection_id,
  })
  assert.equal((readyConnection as { status: string }).status, "READY")
  await models.create({
    tenantId,
    resourceId: resource.resource_id,
    value: {
      model_name: "llama3.2",
      display_name: "Llama 3.2",
      mappings: [{
        connection_id: connection.connection_id,
        provider_model: "llama3.2",
      }],
      capabilities: ["CHAT", "STREAMING"],
      visibility: "PUBLIC",
    },
  })
  const configuredResource = await resources.setPublicationEndpoint({
    tenantId,
    resourceId: resource.resource_id,
    value: {
      gateway_id: "genio-gateway",
      hostname: "ai.example.test",
      base_path: "/",
      visibility: "PUBLIC",
      dns_management: "EXTERNAL",
      dns_verification: "VERIFIED",
      dns_target: null,
    },
  })

  const compiler = createEnforcementChainCompiler({ resources, connections })
  const chain = await compiler.compile({
    tenantId,
    value: {
      resource_id: configuredResource.resource_id,
      capability_id: capabilityId,
      eligible_connection_ids: [connection.connection_id],
      one_policy_revision: 1,
      steps: [
        {
          step_id: "authenticate",
          kind: "AUTHENTICATE",
          phase: "REQUEST",
          implementation: "NATIVE",
          depends_on: [],
          config: jwtConfig,
        },
        {
          step_id: "authorize",
          kind: "AUTHORIZE",
          phase: "REQUEST",
          implementation: "EXT_AUTH",
          depends_on: ["authenticate"],
          config: {},
        },
        {
          step_id: "route",
          kind: "ROUTE",
          phase: "ROUTING",
          implementation: "AIGW_NATIVE",
          depends_on: ["authorize"],
          config: {},
        },
      ],
    },
  })
  const chains = createInMemoryEnforcementChainReader()
  await saveChain(chains, chain)
  const store = createInMemoryPublicationWorkflowStore({
    state,
    resources,
    connections,
    models,
    chains,
    now,
    idFactory: (prefix) => `${prefix}-test`,
    ...(gatewayDelivery ? { gatewayDelivery } : {}),
  })
  const gatewayProjector = projector ?? createInMemoryGatewayProjector({
    source: store,
    signer,
    allowEphemeralSigner: false,
  })
  let requestSequence = 0
  const workflow = createAiResourcePublicationWorkflow({
    resources,
    connections,
    models,
    chains,
    store,
    projector: gatewayProjector,
    now,
    idFactory: (prefix) => `${prefix}-test-${++requestSequence}`,
    onBuildClaimed,
  })

  return {
    resources,
    connections,
    models,
    modelState,
    state,
    chains,
    compiler,
    store,
    workflow,
    resource: configuredResource,
    connectionId: connection.connection_id,
  }
}

async function saveChain(
  chains: ReturnType<typeof createInMemoryEnforcementChainReader>,
  chain: CompiledEnforcementChain,
): Promise<EnforcementChainRevision> {
  return chains.save({ tenantId, chain })
}

async function pendingRequest(fixture: Fixture) {
  return fixture.workflow.requestReview({
    tenantId,
    resourceId: fixture.resource.resource_id,
    requestedBy: "owner-1",
  })
}

async function review(fixture: Fixture, requestId: string) {
  return fixture.workflow.review({
    tenantId,
    resourceId: fixture.resource.resource_id,
    requestId,
    reviewerId: "platform-admin",
    decision: "APPROVE",
  })
}

test("approval claims BUILDING while Resource stays DRAFT, then commits READY/PUBLISHED", async () => {
  let duringBuild: ResourceRegistration | undefined
  const fixture = await createFixture(undefined, async () => {
    duringBuild = await fixture.resources.getResource({
      tenantId,
      resourceId: fixture.resource.resource_id,
    })
    assert.equal(fixture.state.publicationProjections.size, 0)
  })
  const request = await pendingRequest(fixture)
  const published = await review(fixture, request.request_id)

  assert.equal(duringBuild?.lifecycle, "DRAFT")
  assert.equal(published.lifecycle, "PUBLISHED")
  assert.equal(fixture.state.publicationProjections.size, 1)
  const storedRequest = await fixture.store.getRequest({
    tenantId,
    resourceId: fixture.resource.resource_id,
    requestId: request.request_id,
  })
  assert.equal(storedRequest?.state, "APPROVED")
  assert.equal(storedRequest?.publication_state, "READY")
  assert.equal(storedRequest?.attempt_id, "publication-attempt-test")
})

test("a published Resource can stage a verified secondary Connection mapping", async () => {
  const fixture = await createFixture()
  fixture.state.resources.set(`${tenantId}:${fixture.resource.resource_id}`, {
    ...fixture.resource,
    lifecycle: "PUBLISHED",
  })
  const secondary = await fixture.connections.create({
    tenantId,
    resourceId: fixture.resource.resource_id,
    value: {
      display_name: "Secondary",
      provider_type: "OLLAMA",
      provider_profile_id: "provider-ollama",
      endpoint: "http://127.0.0.1:11434/v1",
      routing_priority: 10,
    },
  })
  const verified = await fixture.connections.verify({
    tenantId,
    resourceId: fixture.resource.resource_id,
    connectionId: secondary.connection_id,
  })
  const model = [...fixture.modelState.models.values()][0]!
  const mapping = await fixture.models.addMapping({
    tenantId,
    resourceId: fixture.resource.resource_id,
    modelId: model.model_id,
    value: {
      connection_id: secondary.connection_id,
      provider_model: "llama3-secondary",
      expected_connection_revision: verified.configuration_revision,
    },
  })
  assert.equal(mapping.public_model_id, model.model_id)
  assert.equal(mapping.connection_id, secondary.connection_id)
  assert.equal((await fixture.models.listMappings({
    tenantId,
    resourceId: fixture.resource.resource_id,
    publicModelId: model.model_id,
  })).length, 2)
})

test("a successor Publication atomically replaces the active native projection", async () => {
  const fixture = await createFixture()
  const initialRequest = await pendingRequest(fixture)
  await review(fixture, initialRequest.request_id)
  const initialProjection = [...fixture.state.publicationProjections.values()][0]!
  const secondary = await fixture.connections.create({
    tenantId,
    resourceId: fixture.resource.resource_id,
    value: {
      display_name: "Secondary",
      provider_type: "OLLAMA",
      provider_profile_id: "provider-ollama",
      endpoint: "http://127.0.0.1:11435/v1",
      routing_priority: 10,
    },
  })
  const verified = await fixture.connections.verify({
    tenantId,
    resourceId: fixture.resource.resource_id,
    connectionId: secondary.connection_id,
  })
  const model = [...fixture.modelState.models.values()][0]!
  await fixture.models.addMapping({
    tenantId,
    resourceId: fixture.resource.resource_id,
    modelId: model.model_id,
    value: {
      connection_id: secondary.connection_id,
      provider_model: "llama3-secondary",
      expected_connection_revision: verified.configuration_revision,
    },
  })
  const currentChain = await fixture.chains.getLatest({
    tenantId,
    resourceId: fixture.resource.resource_id,
    capabilityId,
  })
  assert.ok(currentChain)
  const successorChain = await fixture.compiler.compile({
    tenantId,
    value: {
      resource_id: fixture.resource.resource_id,
      capability_id: capabilityId,
      eligible_connection_ids: [fixture.connectionId, secondary.connection_id],
      one_policy_revision: 2,
      steps: currentChain.chain.steps,
    },
  })
  await saveChain(fixture.chains, successorChain)

  const successorRequest = await pendingRequest(fixture)
  const published = await review(fixture, successorRequest.request_id)
  const projections = [...fixture.state.publicationProjections.values()]

  assert.equal(published.lifecycle, "PUBLISHED")
  assert.equal(projections.length, 1)
  assert.notEqual(projections[0]!.publication_id, initialProjection.publication_id)
  assert.equal(projections[0]!.endpoint_revision, initialProjection.endpoint_revision + 1)
  const route = projections[0]!.resources.find((resource) => resource.kind === "AIGatewayRoute")
  assert.ok(route)
  assert.equal(JSON.stringify(route.spec).includes(secondary.connection_id), true)
})

test("publication readiness returns every actionable violation in one response", async () => {
  const fixture = await createFixture()
  fixture.modelState.models.clear()
  fixture.modelState.mappings.clear()
  const chains: EnforcementChainReader = {
    ...fixture.chains,
    async getLatest() {
      return null
    },
  }
  const workflow = createAiResourcePublicationWorkflow({
    resources: fixture.resources,
    connections: fixture.connections,
    models: fixture.models,
    chains,
    store: fixture.store,
    projector: createInMemoryGatewayProjector({
      source: fixture.store,
      signer,
      allowEphemeralSigner: false,
    }),
    now,
  })

  await assert.rejects(
    workflow.requestReview({
      tenantId,
      resourceId: fixture.resource.resource_id,
      requestedBy: "owner-1",
    }),
    (error: unknown) => {
      if (!(error instanceof PlatformApiError)) return false
      assert.equal(error.code, "RESOURCE_NOT_PUBLISHABLE")
      assert.deepEqual(
        error.violations.map((violation) => violation.code),
        ["ENFORCEMENT_CHAIN_REQUIRED", "PUBLIC_MODEL_REQUIRED"],
      )
      return true
    },
  )
})

test("publication schedules the signed projection before exposing the Resource as PUBLISHED", async () => {
  const scheduled: Array<{ tenantId: string; targetId: string; projectionId: string }> = []
  const fixture = await createFixture(undefined, undefined, {
    async deliver(input) {
      const resource = await fixture.resources.getResource({
        tenantId,
        resourceId: fixture.resource.resource_id,
      })
      assert.equal(resource.lifecycle, "DRAFT")
      scheduled.push({
        tenantId: input.tenantId,
        targetId: input.gatewayId,
        projectionId: input.projection.projection_id,
      })
    },
  })
  const request = await pendingRequest(fixture)

  const published = await review(fixture, request.request_id)

  assert.equal(published.lifecycle, "PUBLISHED")
  const storedProjection = [...fixture.state.publicationProjections.values()][0]
  assert.ok(storedProjection)
  assert.deepEqual(scheduled, [{
    tenantId,
    targetId: "genio-gateway",
    projectionId: storedProjection.projection_id,
  }])
})

test("publication remains DRAFT when no Gateway Runtime can accept the projection", async () => {
  const fixture = await createFixture(undefined, undefined, {
    async deliver() {
      throw new PlatformApiError("GATEWAY_RUNTIME_NOT_REGISTERED", 409)
    },
  })
  const request = await pendingRequest(fixture)

  await assert.rejects(
    review(fixture, request.request_id),
    (error: unknown) =>
      error instanceof PlatformApiError &&
      error.code === "GATEWAY_RUNTIME_NOT_REGISTERED",
  )

  const resource = await fixture.resources.getResource({
    tenantId,
    resourceId: fixture.resource.resource_id,
  })
  assert.equal(resource.lifecycle, "DRAFT")
  const failed = await fixture.store.getRequest({
    tenantId,
    resourceId: fixture.resource.resource_id,
    requestId: request.request_id,
  })
  assert.equal(failed?.publication_state, "FAILED")
  assert.equal(failed?.failure_code, "GATEWAY_RUNTIME_NOT_REGISTERED")
})

test("a rejected Publication can be submitted again with a new immutable snapshot", async () => {
  const fixture = await createFixture()
  const first = await pendingRequest(fixture)
  const rejected = await fixture.workflow.review({
    tenantId,
    resourceId: fixture.resource.resource_id,
    requestId: first.request_id,
    reviewerId: "platform-admin",
    decision: "REJECT",
  })
  assert.equal(rejected.lifecycle, "DRAFT")
  assert.equal(rejected.publication_request?.state, "REJECTED")
  assert.equal(fixture.state.publicationSnapshots.size, 0)

  const second = await pendingRequest(fixture)
  assert.notEqual(second.request_id, first.request_id)
  assert.equal(fixture.state.publicationSnapshots.size, 1)
  assert.equal(
    await fixture.store.getRequest({
      tenantId,
      resourceId: fixture.resource.resource_id,
      requestId: first.request_id,
    }),
    null,
  )

  const published = await review(fixture, second.request_id)
  assert.equal(published.lifecycle, "PUBLISHED")
  assert.equal(published.publication_request?.state, "APPROVED")
})

test("projection/signing failure leaves Resource DRAFT and marks request/attempt FAILED", async () => {
  const projector: GatewayProjector = {
    async compile() {
      throw new PlatformApiError("GATEWAY_PROJECTION_SIGNATURE_FAILED", 500)
    },
  }
  const fixture = await createFixture(projector)
  const request = await pendingRequest(fixture)

  await assert.rejects(
    review(fixture, request.request_id),
    (error: unknown) =>
      error instanceof PlatformApiError &&
      error.code === "GATEWAY_PROJECTION_SIGNATURE_FAILED",
  )
  const resource = await fixture.resources.getResource({
    tenantId,
    resourceId: fixture.resource.resource_id,
  })
  assert.equal(resource.lifecycle, "DRAFT")
  const failedRequest = await fixture.store.getRequest({
    tenantId,
    resourceId: fixture.resource.resource_id,
    requestId: request.request_id,
  })
  assert.equal(failedRequest?.state, "PENDING")
  assert.equal(failedRequest?.publication_state, "FAILED")
  assert.equal(failedRequest?.failure_code, "GATEWAY_PROJECTION_SIGNATURE_FAILED")
  assert.equal(fixture.state.publicationAttempts.size, 1)
  assert.equal([...fixture.state.publicationAttempts.values()][0]?.state, "FAILED")
})

test("changes after review snapshot are rejected before publish", async (t) => {
  const driftCases: Array<{
    name: string
    mutate(fixture: Fixture): Promise<void>
  }> = [
    {
      name: "resource content",
      mutate: async (fixture) => {
        await fixture.resources.updateResource({
          tenantId,
          resourceId: fixture.resource.resource_id,
          value: { version: "2.0.0" },
        })
      },
    },
    {
      name: "publication endpoint",
      mutate: async (fixture) => {
        await fixture.resources.setPublicationEndpoint({
          tenantId,
          resourceId: fixture.resource.resource_id,
          value: {
            gateway_id: "genio-gateway",
            hostname: "changed.example.test",
            base_path: "/v2",
            visibility: "PUBLIC",
            dns_management: "EXTERNAL",
            dns_verification: "VERIFIED",
            dns_target: null,
          },
        })
      },
    },
    {
      name: "eligible Connection",
      mutate: async (fixture) => {
        await fixture.connections.update({
          tenantId,
          resourceId: fixture.resource.resource_id,
          connectionId: fixture.connectionId,
          value: { display_name: "Changed after review", expected_revision: 2 },
        })
      },
    },
    {
      name: "PUBLIC model set",
      mutate: async (fixture) => {
        await fixture.models.create({
          tenantId,
          resourceId: fixture.resource.resource_id,
          value: {
            model_name: "llama3.1",
            display_name: "Llama 3.1",
            mappings: [{
              connection_id: fixture.connectionId,
              provider_model: "llama3.1",
            }],
            visibility: "PUBLIC",
          },
        })
      },
    },
    {
      name: "model mapping",
      mutate: async (fixture) => {
        const mapping = [...fixture.modelState.mappings.values()][0]
        assert.ok(mapping)
        fixture.modelState.mappings.set(
          `${mapping.tenant_id}:${mapping.mapping_id}`,
          { ...mapping, provider_model: "llama3.2-drifted", mapping_revision: 2 },
        )
      },
    },
    {
      name: "latest Enforcement Chain",
      mutate: async (fixture) => {
        const next = await fixture.compiler.compile({
          tenantId,
          value: {
            resource_id: fixture.resource.resource_id,
            capability_id: capabilityId,
            eligible_connection_ids: [fixture.connectionId],
            one_policy_revision: 2,
            steps: [
              {
                step_id: "authenticate",
                kind: "AUTHENTICATE",
                phase: "REQUEST",
                implementation: "NATIVE",
                depends_on: [],
                config: jwtConfig,
              },
              {
                step_id: "authorize",
                kind: "AUTHORIZE",
                phase: "REQUEST",
                implementation: "EXT_AUTH",
                depends_on: ["authenticate"],
                config: {},
              },
              {
                step_id: "route",
                kind: "ROUTE",
                phase: "ROUTING",
                implementation: "AIGW_NATIVE",
                depends_on: ["authorize"],
                config: {},
              },
            ],
          },
        })
        await saveChain(fixture.chains, next)
      },
    },
  ]

  for (const driftCase of driftCases) {
    await t.test(driftCase.name, async () => {
      const fixture = await createFixture()
      const request = await pendingRequest(fixture)
      await driftCase.mutate(fixture)

      await assert.rejects(
        review(fixture, request.request_id),
        (error: unknown) =>
          error instanceof PlatformApiError &&
          error.code === "PUBLICATION_SNAPSHOT_STALE",
      )
      const resource = await fixture.resources.getResource({
        tenantId,
        resourceId: fixture.resource.resource_id,
      })
      assert.equal(resource.lifecycle, "DRAFT")
      const failedRequest = await fixture.store.getRequest({
        tenantId,
        resourceId: fixture.resource.resource_id,
        requestId: request.request_id,
      })
      assert.equal(failedRequest?.state, "PENDING")
      assert.equal(failedRequest?.publication_state, "FAILED")
    })
  }
})
