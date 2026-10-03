import { createInMemoryEndpointRuntimeStore } from "../src/capabilities/endpoint-runtime/memory"
import assert from "node:assert/strict"
import test from "node:test"
import type { FastifyRequest } from "fastify"

import { PlatformApiError } from "../src/capabilities/errors"
import { createInMemoryGatewayAuthorizationAuditStore } from "../src/capabilities/audit-events/memory"
import { createManagementAuthorization } from "../src/capabilities/management-authorization/module"
import type { Principal } from "../src/capabilities/tenancy-auth/contract"
import type { RuntimeControlStore } from "../src/capabilities/runtime-control/contract"

const organizationPrincipal: Principal = {
  tenant_id: "tenant-acme",
  subject_id: "person-owner",
  role: "ORGANIZATION_ADMINISTRATOR",
  organization_ids: ["organization-owner"],
  administrator_organization_ids: ["organization-owner"],
  client_id: "management-ui",
  scopes: ["genioone-management"],
}

function request(value: {
  url: string
  method: string
  token?: string
  body?: unknown
}): FastifyRequest {
  return {
    url: value.url,
    method: value.method,
    headers: value.token ? { authorization: `Bearer ${value.token}` } : {},
    body: value.body,
  } as FastifyRequest
}

function authorization(principal = organizationPrincipal, auditEvents = createInMemoryGatewayAuthorizationAuditStore()) {
  return createManagementAuthorization({
    endpointRuntime: createInMemoryEndpointRuntimeStore(),
    principalAuthenticator: {
      authenticate: ({ token }) => token === "accepted" ? principal : null,
    },
    entitlementResolver: {
      resolve: () => ["model-alpha", "model-alpha", "model-beta"],
    },
    resourceCatalog: {
      listResources: async () => [],
      getResource: async () => ({
        tenant_id: "tenant-acme",
        resource_id: "resource-owned",
        owner_organization_id: "organization-owner",
      }) as never,
    },
    runtimeControl: {
      getGatewayRuntime: async () => null,
    } as unknown as RuntimeControlStore,
    auditEvents,
  })
}

test("Management authorization authenticates, derives the actor, and enforces Resource ownership", async () => {
  const module = authorization()
  const input = request({
    url: "/v1/tenants/tenant-acme/resources/resource-owned/publication-requests",
    method: "POST",
    token: "accepted",
    body: {},
  })

  await module.authenticate(input)
  await module.normalize(input)
  await module.authorize(input)

  assert.equal(input.principal?.subject_id, "person-owner")
  assert.deepEqual(input.body, { requested_by: "person-owner" })
  assert.equal(input.routeResource?.resource_id, "resource-owned")
})

test("Management authorization audit separates verified actors from requested resource context", async () => {
  const auditEvents = createInMemoryGatewayAuthorizationAuditStore()
  const module = authorization(organizationPrincipal, auditEvents)
  const input = request({
    url: "/v1/tenants/tenant-acme/resources/resource-owned/publication-requests",
    method: "POST",
    token: "accepted",
    body: {},
  })

  await module.authenticate(input)
  await module.normalize(input)
  await module.authorize(input)

  const result = await auditEvents.query({
    tenantId: "tenant-acme",
    kind: "MANAGEMENT_AUTHORIZATION",
    outcome: "ALLOW",
    offset: 0,
    limit: 10,
  })
  assert.equal(result.events.length, 1)
  const event = result.events[0]
  assert.equal(event?.kind, "MANAGEMENT_AUTHORIZATION")
  if (event?.kind !== "MANAGEMENT_AUTHORIZATION") return
  assert.equal(event.tenant_id, "tenant-acme")
  assert.equal(event.subject.subject_id, organizationPrincipal.subject_id)
  assert.equal(event.request_context.requested_tenant_id, "tenant-acme")
  assert.equal(event.request_context.target.resource_id, "resource-owned")
  assert.equal(event.request_context.target.organization_id, null)
})

test("Management authorization rejects spoofed model actors before resolving entitlement", async () => {
  const module = authorization()
  const input = request({
    url: "/v1/tenants/tenant-acme/model-routing/resolve",
    method: "POST",
    token: "accepted",
    body: { subject_id: "person-other", entitled_public_model_ids: ["model-injected"] },
  })

  await module.authenticate(input)
  await assert.rejects(
    module.normalize(input),
    (error: unknown) => error instanceof PlatformApiError && error.code === "ACTOR_SPOOFED",
  )
})

test("Management authorization classifies Gateway Runtime transport independently from management routes", async () => {
  const module = authorization()
  const input = request({
    url: "/v1/tenants/tenant-acme/runtime-control/GATEWAY/runtime-one/aggregate/commands/next",
    method: "GET",
    token: "accepted",
  })

  await assert.rejects(
    module.authenticate(input),
    (error: unknown) => error instanceof PlatformApiError && error.code === "INSUFFICIENT_SCOPE",
  )
})

test("Memory invocation routes require an explicit invocation scope", async () => {
  const invocationUser: Principal = {
    ...organizationPrincipal,
    role: "USER",
    organization_ids: [],
    administrator_organization_ids: [],
    scopes: ["genioone-invocation"],
  }
  const module = authorization(invocationUser)
  const allowed = [
    { method: "GET", path: "me/memories" },
    { method: "POST", path: "me/memories" },
    { method: "GET", path: "me/memories/memory-personal" },
    { method: "POST", path: "me/memory-agents" },
    { method: "GET", path: "me/memory-agents/agent-personal" },
    { method: "POST", path: "memory/mcp" },
    { method: "GET", path: "me/memory-scopes" },
    { method: "POST", path: "team-workspaces/workspace-one/memories" },
    { method: "GET", path: "team-workspaces/workspace-one/memories/memory-shared" },
    { method: "POST", path: "team-workspaces/workspace-one/memories/memory-shared/corrections" },
    { method: "POST", path: "team-workspaces/workspace-one/memories/memory-shared/corrections/proposal-one/review" },
    { method: "POST", path: "organizations/organization-one/memories" },
    { method: "GET", path: "organizations/organization-one/memories/memory-shared" },
    { method: "POST", path: "organizations/organization-one/memories/memory-shared/corrections" },
    { method: "POST", path: "organizations/organization-one/memories/memory-shared/corrections/proposal-one/review" },
  ]

  for (const route of allowed) {
    const input = request({
      url: `/v1/tenants/tenant-acme/${route.path}`,
      method: route.method,
      token: "accepted",
    })
    await module.authenticate(input)
    await module.normalize(input)
    await module.authorize(input)
    assert.equal(input.principal?.subject_id, invocationUser.subject_id)
  }

  for (const principal of [
    { ...invocationUser, scopes: ["genioone-management"] },
    { ...invocationUser, scopes: ["genioone-gateway-runtime"] },
    { ...invocationUser, scopes: ["genioone-endpoint-runtime"] },
    { ...invocationUser, scopes: undefined },
  ]) {
    const input = request({
      url: "/v1/tenants/tenant-acme/team-workspaces/workspace-one/memories",
      method: "GET",
      token: "accepted",
    })
    await assert.rejects(
      authorization(principal).authenticate(input),
      (error: unknown) => error instanceof PlatformApiError && error.code === "INSUFFICIENT_SCOPE",
    )
  }

  const endpointCredential = request({
    url: "/v1/tenants/tenant-acme/team-workspaces/workspace-one/memories",
    method: "GET",
    token: "genio_endpoint_memory",
  })
  await assert.rejects(
    module.authenticate(endpointCredential),
    (error: unknown) => error instanceof PlatformApiError && error.code === "ENDPOINT_CREDENTIAL_REJECTED",
  )

  const anonymous = request({
    url: "/v1/tenants/tenant-acme/team-workspaces/workspace-one/memories",
    method: "GET",
  })
  await assert.rejects(
    module.authenticate(anonymous),
    (error: unknown) => error instanceof PlatformApiError && error.code === "UNAUTHENTICATED",
  )
})

test("Memory invocation scope denial is recorded as an authorization decision", async () => {
  const auditEvents = createInMemoryGatewayAuthorizationAuditStore()
  const module = authorization(organizationPrincipal, auditEvents)
  const input = request({
    url: "/v1/tenants/tenant-acme/me/memories",
    method: "GET",
    token: "accepted",
  })

  await assert.rejects(
    module.authenticate(input),
    (error: unknown) => error instanceof PlatformApiError && error.code === "INSUFFICIENT_SCOPE",
  )

  const result = await auditEvents.query({
    tenantId: "tenant-acme",
    kind: "MANAGEMENT_AUTHORIZATION",
    outcome: "DENY",
    offset: 0,
    limit: 10,
  })
  assert.equal(result.events.length, 1)
  const event = result.events[0]
  assert.equal(event?.kind, "MANAGEMENT_AUTHORIZATION")
  if (event?.kind !== "MANAGEMENT_AUTHORIZATION") return
  assert.equal(event.code, "INSUFFICIENT_SCOPE")
  assert.equal(event.subject.subject_id, organizationPrincipal.subject_id)
  assert.equal(event.request_context.requested_tenant_id, "tenant-acme")
})

test("Memory invocation classification accepts only the exact shared paths", async () => {
  const invocationUser: Principal = {
    ...organizationPrincipal,
    role: "USER",
    organization_ids: [],
    administrator_organization_ids: [],
    scopes: ["genioone-invocation"],
  }
  const module = authorization(invocationUser)

  for (const path of ["team-workspaces", "team-workspaces/workspace-one"]) {
    const input = request({
      url: `/v1/tenants/tenant-acme/${path}`,
      method: "GET",
      token: "accepted",
    })
    await module.authenticate(input)
  }

  for (const route of [
    { method: "GET", path: "team-workspaces/workspace-one/memories/memory-one/corrections/proposal-one" },
    { method: "GET", path: "team-workspaces/workspace-one/memories/memory-one/corrections/proposal-one/review/extra" },
    { method: "GET", path: "team-workspaces/workspace-one/unrelated" },
    { method: "GET", path: "organizations/organization-one/memories/memory-one/corrections/proposal-one" },
    { method: "GET", path: "organizations/organization-one/unrelated" },
    { method: "POST", path: "me/memory-scopes" },
  ]) {
    const input = request({
      url: `/v1/tenants/tenant-acme/${route.path}`,
      method: route.method,
      token: "accepted",
    })
    await assert.rejects(
      module.authenticate(input),
      (error: unknown) => error instanceof PlatformApiError && error.code === "INSUFFICIENT_SCOPE",
    )
  }
})

test("Management authorization permits only lifecycle toggles for installed built-in Resources", async () => {
  const principal: Principal = {
    ...organizationPrincipal,
    role: "TENANT_ADMINISTRATOR",
    organization_ids: [],
  }
  const module = createManagementAuthorization({
    endpointRuntime: createInMemoryEndpointRuntimeStore(),
    principalAuthenticator: {
      authenticate: ({ token }) => token === "accepted" ? principal : null,
    },
    resourceCatalog: {
      listResources: async () => [],
      getResource: async () => ({
        tenant_id: "tenant-acme",
        resource_id: "genio-one-discovery",
        owner_organization_id: "genio-one-system",
        builtin_service: "DISCOVERY",
        installation_owned: true,
        service_kind: "DISCOVERY",
      }) as never,
    },
    runtimeControl: { getGatewayRuntime: async () => null } as unknown as RuntimeControlStore,
    auditEvents: createInMemoryGatewayAuthorizationAuditStore(),
  })
  const toggle = request({
    url: "/v1/tenants/tenant-acme/resources/genio-one-discovery/connections/genio-one-discovery/lifecycle",
    method: "POST",
    token: "accepted",
    body: { command: "DISABLE" },
  })
  await module.authenticate(toggle)
  await module.normalize(toggle)
  await module.authorize(toggle)

  const mutation = request({
    url: "/v1/tenants/tenant-acme/resources/genio-one-discovery/connections/genio-one-discovery",
    method: "DELETE",
    token: "accepted",
  })
  await module.authenticate(mutation)
  await module.normalize(mutation)
  await assert.rejects(
    module.authorize(mutation),
    (error: unknown) => error instanceof PlatformApiError && error.code === "BUILTIN_RESOURCE_MANAGED_BY_PLATFORM",
  )
})

test("Organization Administrators can update only scoped Organizations and Access Groups", async () => {
  const module = authorization()
  const ownOrganization = request({
    url: "/v1/tenants/tenant-acme/organizations/organization-owner",
    method: "PUT",
    token: "accepted",
    body: {},
  })
  await module.authenticate(ownOrganization)
  await module.normalize(ownOrganization)
  await module.authorize(ownOrganization)

  const otherOrganization = request({
    url: "/v1/tenants/tenant-acme/organizations/organization-other",
    method: "PUT",
    token: "accepted",
    body: {},
  })
  await module.authenticate(otherOrganization)
  await module.normalize(otherOrganization)
  await assert.rejects(
    module.authorize(otherOrganization),
    (error: unknown) => error instanceof PlatformApiError && error.code === "RESOURCE_OWNER_OR_TENANT_ADMIN_REQUIRED",
  )

  const accessGroups = request({
    url: "/v1/tenants/tenant-acme/access-groups",
    method: "GET",
    token: "accepted",
  })
  await module.authenticate(accessGroups)
  await module.normalize(accessGroups)
  await module.authorize(accessGroups)

  const userModule = authorization({ ...organizationPrincipal, role: "USER" })
  const userAccessGroups = request({
    url: "/v1/tenants/tenant-acme/access-groups",
    method: "GET",
    token: "accepted",
  })
  await userModule.authenticate(userAccessGroups)
  await userModule.normalize(userAccessGroups)
  await assert.rejects(
    userModule.authorize(userAccessGroups),
    (error: unknown) => error instanceof PlatformApiError && error.code === "TENANT_ADMINISTRATOR_REQUIRED",
  )
})

test("Organization membership alone cannot authorize Organization mutation", async () => {
  const module = authorization({
    ...organizationPrincipal,
    administrator_organization_ids: [],
  })
  const input = request({
    url: "/v1/tenants/tenant-acme/organizations/organization-owner",
    method: "PUT",
    token: "accepted",
    body: {},
  })
  await module.authenticate(input)
  await module.normalize(input)
  await assert.rejects(
    module.authorize(input),
    (error: unknown) => error instanceof PlatformApiError && error.code === "RESOURCE_OWNER_OR_TENANT_ADMIN_REQUIRED",
  )
})

test("member Resource reads do not grant Connection management visibility", async () => {
  const member = authorization({ ...organizationPrincipal, role: "USER", administrator_organization_ids: [] })
  const resourceDetail = request({ url: "/v1/tenants/tenant-acme/resources/resource-owned", method: "GET", token: "accepted" })
  await member.authenticate(resourceDetail)
  await member.authorize(resourceDetail)

  for (const principal of [
    { ...organizationPrincipal, role: "USER" as const, administrator_organization_ids: [] },
    { ...organizationPrincipal, administrator_organization_ids: [] },
  ]) {
    const module = authorization(principal)
    const connections = request({ url: "/v1/tenants/tenant-acme/resources/resource-owned/connections", method: "GET", token: "accepted" })
    await module.authenticate(connections)
    await assert.rejects(module.authorize(connections), (error: unknown) =>
      error instanceof PlatformApiError && error.code === "RESOURCE_OWNER_OR_TENANT_ADMIN_REQUIRED")
  }

  const owner = authorization()
  const ownedConnections = request({ url: "/v1/tenants/tenant-acme/resources/resource-owned/connections", method: "GET", token: "accepted" })
  await owner.authenticate(ownedConnections)
  await owner.authorize(ownedConnections)
})

test("raw tenant telemetry requires tenant administration rather than organization access", async () => {
  for (const path of ["logs", "traces", `traces/${"a".repeat(32)}/spans`]) {
    for (const role of ["USER", "ORGANIZATION_ADMINISTRATOR", "TENANT_ADMINISTRATOR"] as const) {
      const module = authorization({ ...organizationPrincipal, role })
      const input = request({ url: `/v1/tenants/tenant-acme/${path}`, method: "GET", token: "accepted" })
      await module.authenticate(input)
      if (role === "TENANT_ADMINISTRATOR") await module.authorize(input)
      else await assert.rejects(module.authorize(input), error => error instanceof PlatformApiError && error.statusCode === 403)
    }
  }
})

test("audit event list requires Tenant Administrator authorization", async () => {
  for (const role of ["USER", "ORGANIZATION_ADMINISTRATOR", "TENANT_ADMINISTRATOR"] as const) {
    const module = authorization({ ...organizationPrincipal, role })
    const input = request({
      url: "/v1/tenants/tenant-acme/audit-events?kind=ACCESS_GOVERNANCE_CHANGE",
      method: "GET",
      token: "accepted",
    })
    await module.authenticate(input)
    if (role === "TENANT_ADMINISTRATOR") {
      await module.authorize(input)
    } else {
      await assert.rejects(
        module.authorize(input),
        (error: unknown) => error instanceof PlatformApiError && error.code === "TENANT_ADMINISTRATOR_REQUIRED",
      )
    }
  }
})

test("audit export read requires Tenant Administrator authorization", async () => {
  for (const role of ["USER", "ORGANIZATION_ADMINISTRATOR", "TENANT_ADMINISTRATOR"] as const) {
    const module = authorization({ ...organizationPrincipal, role, scopes: ["genioone-management", "audit.export"] })
    const input = request({
      url: "/v1/tenants/tenant-acme/audit-export",
      method: "GET",
      token: "accepted",
    })
    await module.authenticate(input)
    if (role === "TENANT_ADMINISTRATOR") {
      await module.authorize(input)
    } else {
      await assert.rejects(
        module.authorize(input),
        (error: unknown) => error instanceof PlatformApiError && error.code === "TENANT_ADMINISTRATOR_REQUIRED",
      )
    }
  }
})
