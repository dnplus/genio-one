import { createInMemoryEndpointRuntimeStore } from "../src/capabilities/endpoint-runtime/memory"
import assert from "node:assert/strict"
import test from "node:test"
import type { FastifyRequest } from "fastify"

import { PlatformApiError } from "../src/capabilities/errors"
import { createManagementAuthorization } from "../src/capabilities/management-authorization/module"
import type { Principal } from "../src/capabilities/tenancy-auth/contract"
import type { RuntimeControlStore } from "../src/capabilities/runtime-control/contract"

const organizationPrincipal: Principal = {
  tenant_id: "tenant-acme",
  subject_id: "person-owner",
  role: "ORGANIZATION_ADMINISTRATOR",
  organization_ids: ["organization-owner"],
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

function authorization(principal = organizationPrincipal) {
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
