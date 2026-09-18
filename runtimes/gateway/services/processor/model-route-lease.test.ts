import assert from "node:assert/strict"
import test from "node:test"

import type { RedisClientType } from "redis"

import type { ProcessingContext } from "./contract"
import {
  ValkeyGatewayModelRouteResolver,
} from "./model-route-lease"
import {
  gatewayRoutingCandidateSetDigest,
  narrowGatewayRoutingScopeByObligations,
  type GatewayRoutingScope,
} from "../shared/gateway-routing-artifact"

test("a second request in the same scoped session reuses the exact route lease", async () => {
  const values = new Map<string, string>()
  const client = {
    isOpen: true,
    async connect() {},
    async get(key: string) {
      return values.get(key) ?? null
    },
    async set(key: string, value: string) {
      if (values.has(key)) return null
      values.set(key, value)
      return "OK"
    },
    async quit() {},
  } as unknown as RedisClientType
  const resolver = new ValkeyGatewayModelRouteResolver("redis://unused", client)
  const context: ProcessingContext = {
    tenantId: "tenant-1",
    subjectId: "person-1",
    clientId: "client-1",
    resourceId: "resource-1",
    capabilityId: "model.invoke",
    sessionId: "session-1",
    correlationId: "correlation-1",
  }
  const scope: GatewayRoutingScope = {
    owner_organization_id: "organization-1",
    resource_id: context.resourceId,
    capability_id: context.capabilityId,
    routing_policy_id: "routing-policy-1",
    routing_revision: 1,
    one_policy_revision: 1,
    route_mode: "SESSION_LEASE",
    default_public_model_id: "model-1",
    candidate_set_digest: "a".repeat(64),
    session_lease: {
      ttl_seconds: 900,
      key_scope: "TENANT_SUBJECT_CLIENT_RESOURCE_CAPABILITY_SESSION",
    },
    candidates: [{
      order: 1,
      public_model_id: "model-1",
      public_model_name: "genio-chat",
      mappings: [{
        order: 1,
        mapping_id: "mapping-1",
        resource_id: context.resourceId,
        connection_id: "connection-1",
        connection_configuration_revision: 3,
        provider_credential_profile_id: "provider-credential-1",
        provider_credential_profile_revision: 4,
        provider_credential_strategy_digest: "b".repeat(64),
        provider_model: "provider-model-1",
        mapping_revision: 1,
      }],
    }],
  }
  const input = {
    context,
    scope,
    body: Buffer.from(JSON.stringify({ model: "genio-chat", messages: [] })),
    allowedPublicModels: ["genio-chat"],
  }

  const first = await resolver.resolve(input)
  const second = await resolver.resolve({
    ...input,
    context: { ...context, correlationId: "correlation-2" },
  })

  assert.equal(first.reused, false)
  assert.equal(second.reused, true)
  assert.equal(second.lease.lease_id, first.lease.lease_id)
  assert.equal(second.lease.connection_id, "connection-1")
  assert.equal(second.lease.provider_credential_profile_id, "provider-credential-1")
  assert.equal(second.lease.provider_credential_profile_revision, 4)
})

test("a successor or revoked Provider Credential Profile invalidates an existing route lease", async () => {
  const values = new Map<string, string>()
  const client = {
    isOpen: true,
    async connect() {},
    async get(key: string) {
      return values.get(key) ?? null
    },
    async set(key: string, value: string) {
      if (values.has(key)) return null
      values.set(key, value)
      return "OK"
    },
    async quit() {},
  } as unknown as RedisClientType
  const resolver = new ValkeyGatewayModelRouteResolver("redis://unused", client)
  const context: ProcessingContext = {
    tenantId: "tenant-1",
    subjectId: "application-1",
    clientId: "client-1",
    resourceId: "resource-1",
    capabilityId: "model.invoke",
    sessionId: "session-credential-1",
    correlationId: "correlation-1",
  }
  const scope = (revision: number, digest: string): GatewayRoutingScope => ({
    owner_organization_id: "organization-1",
    resource_id: context.resourceId,
    capability_id: context.capabilityId,
    routing_policy_id: "routing-policy-1",
    routing_revision: 1,
    one_policy_revision: 1,
    route_mode: "SESSION_LEASE",
    default_public_model_id: "model-1",
    candidate_set_digest: "a".repeat(64),
    session_lease: {
      ttl_seconds: 900,
      key_scope: "TENANT_SUBJECT_CLIENT_RESOURCE_CAPABILITY_SESSION",
    },
    candidates: [{
      order: 1,
      public_model_id: "model-1",
      public_model_name: "genio-chat",
      mappings: [{
        order: 1,
        mapping_id: "mapping-1",
        resource_id: context.resourceId,
        connection_id: "connection-1",
        connection_configuration_revision: 3,
        provider_credential_profile_id: "provider-credential-1",
        provider_credential_profile_revision: revision,
        provider_credential_strategy_digest: digest,
        provider_model: "provider-model-1",
        mapping_revision: 1,
      }],
    }],
  })
  const body = Buffer.from(JSON.stringify({ model: "genio-chat", messages: [] }))
  await resolver.resolve({
    context,
    scope: scope(4, "b".repeat(64)),
    body,
    allowedPublicModels: ["genio-chat"],
  })
  await assert.rejects(
    resolver.resolve({
      context: { ...context, correlationId: "correlation-2" },
      scope: scope(5, "c".repeat(64)),
      body,
      allowedPublicModels: ["genio-chat"],
    }),
    /route lease is no longer eligible/,
  )
})

test("classifier choice creates a lease and a later fallback prompt cannot switch it", async () => {
  const values = new Map<string, string>()
  const client = {
    isOpen: true,
    async connect() {},
    async get(key: string) {
      return values.get(key) ?? null
    },
    async set(key: string, value: string) {
      if (values.has(key)) return null
      values.set(key, value)
      return "OK"
    },
    async quit() {},
  } as unknown as RedisClientType
  const resolver = new ValkeyGatewayModelRouteResolver("redis://unused", client)
  const context: ProcessingContext = {
    tenantId: "tenant-1",
    subjectId: "person-1",
    clientId: "client-1",
    resourceId: "resource-1",
    capabilityId: "model.invoke",
    sessionId: "session-1",
    correlationId: "correlation-1",
  }
  const candidate = (order: number, id: string, name: string) => ({
    order,
    public_model_id: id,
    public_model_name: name,
    mappings: [{
      order: 1,
      mapping_id: `mapping-${id}`,
      resource_id: context.resourceId,
      connection_id: "connection-1",
      provider_model: "provider-model-1",
      mapping_revision: 1,
    }],
  })
  const scope: GatewayRoutingScope = {
    owner_organization_id: "organization-1",
    resource_id: context.resourceId,
    capability_id: context.capabilityId,
    routing_policy_id: "routing-policy-1",
    routing_revision: 1,
    one_policy_revision: 1,
    route_mode: "SESSION_LEASE",
    default_public_model_id: "model-default",
    candidate_set_digest: "a".repeat(64),
    session_lease: {
      ttl_seconds: 900,
      key_scope: "TENANT_SUBJECT_CLIENT_RESOURCE_CAPABILITY_SESSION",
    },
    candidates: [
      candidate(1, "model-default", "default-chat"),
      candidate(2, "model-expert", "expert-chat"),
    ],
  }
  const allowedPublicModels = ["default-chat", "expert-chat"]
  const first = await resolver.resolve({
    context,
    scope,
    requestedPublicModelName: "default-chat",
    body: Buffer.from(JSON.stringify({ model: "expert-chat", messages: [] })),
    allowedPublicModels,
  })
  const second = await resolver.resolve({
    context: { ...context, correlationId: "correlation-2" },
    scope,
    requestedPublicModelName: "default-chat",
    body: Buffer.from(JSON.stringify({ model: "default-chat", messages: [] })),
    allowedPublicModels,
  })

  assert.equal(first.lease.selected_public_model_name, "expert-chat")
  assert.equal(first.lease.requested_public_model_id, "model-default")
  assert.equal(second.reused, true)
  assert.equal(second.lease.lease_id, first.lease.lease_id)
  assert.equal(second.lease.selected_public_model_name, "expert-chat")
  assert.equal(JSON.parse(Buffer.from(second.body).toString()).model, "expert-chat")
})

test("a risk obligation narrows the route and invalidates a lease outside the admitted set", async () => {
  const values = new Map<string, string>()
  const client = {
    isOpen: true,
    async connect() {},
    async get(key: string) {
      return values.get(key) ?? null
    },
    async set(key: string, value: string) {
      if (values.has(key)) return null
      values.set(key, value)
      return "OK"
    },
    async quit() {},
  } as unknown as RedisClientType
  const resolver = new ValkeyGatewayModelRouteResolver("redis://unused", client)
  const context: ProcessingContext = {
    tenantId: "tenant-1",
    subjectId: "person-1",
    clientId: "client-1",
    resourceId: "resource-1",
    capabilityId: "model.invoke",
    sessionId: "session-risk-1",
    correlationId: "correlation-low",
  }
  const candidates: GatewayRoutingScope["candidates"] = [{
    order: 1,
    public_model_id: "model-1",
    public_model_name: "genio-chat",
    mappings: [{
      order: 1,
      mapping_id: "mapping-primary",
      resource_id: context.resourceId,
      connection_id: "connection-primary",
      provider_model: "model-primary",
      mapping_revision: 1,
      supported_obligations: ["audit"],
    }, {
      order: 2,
      mapping_id: "mapping-controlled",
      resource_id: context.resourceId,
      connection_id: "connection-controlled",
      provider_model: "model-controlled",
      mapping_revision: 1,
      supported_obligations: ["audit", "dlp"],
    }],
  }]
  const scope: GatewayRoutingScope = {
    owner_organization_id: "organization-1",
    resource_id: context.resourceId,
    capability_id: context.capabilityId,
    routing_policy_id: "routing-policy-1",
    routing_revision: 1,
    one_policy_revision: 1,
    route_mode: "SESSION_LEASE",
    default_public_model_id: "model-1",
    candidate_set_digest: gatewayRoutingCandidateSetDigest(candidates),
    session_lease: {
      ttl_seconds: 900,
      key_scope: "TENANT_SUBJECT_CLIENT_RESOURCE_CAPABILITY_SESSION",
    },
    candidates,
  }
  const body = Buffer.from(JSON.stringify({ model: "genio-chat", messages: [] }))
  const first = await resolver.resolve({
    context,
    scope,
    body,
    allowedPublicModels: ["genio-chat"],
  })
  assert.equal(first.lease.connection_id, "connection-primary")

  const highRiskScope = narrowGatewayRoutingScopeByObligations(scope, ["dlp"])
  assert.deepEqual(
    highRiskScope.candidates[0]!.mappings.map((mapping) => mapping.connection_id),
    ["connection-controlled"],
  )
  await assert.rejects(
    resolver.resolve({
      context: { ...context, correlationId: "correlation-high" },
      scope: highRiskScope,
      body,
      allowedPublicModels: ["genio-chat"],
    }),
    /route lease conflicts with the current request or policy/,
  )
})
