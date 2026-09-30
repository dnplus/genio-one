import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"

import { PlatformApiError } from "../src/capabilities/errors"
import { createManagementAuthorization } from "../src/capabilities/management-authorization/module"
import { postHogIntegrationHttp } from "../src/capabilities/posthog-integration/http"
import { createInMemoryPostHogIntegrationStore } from "../src/capabilities/posthog-integration/memory"
import { createPostgresPostHogIntegrationStore } from "../src/capabilities/posthog-integration/postgres"
import type { SqlAdapter } from "../src/persistence/sql-adapter"
import type { EndpointRuntimeStore } from "../src/capabilities/endpoint-runtime/module"
import type { ResourceCatalog } from "../src/capabilities/resources/module"
import type { RuntimeControlStore } from "../src/capabilities/runtime-control/contract"
import type { Principal } from "../src/capabilities/tenancy-auth/contract"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"

test("PostHog enabled tenant lookup returns only tenant IDs", async () => {
  let statement = ""
  const store = createPostgresPostHogIntegrationStore({
    sql: {
      async query(text) {
        statement = text
        return {
          rows: [{ tenant_id: "tenant-enabled" }],
          rowCount: 1,
        }
      },
    } as SqlAdapter,
  })

  assert.deepEqual(await store.listEnabledTenantIds(), ["tenant-enabled"])
  assert.match(statement, /select tenant_id/i)
  assert.match(statement, /where enabled = true/i)
  assert.doesNotMatch(statement, /project_token/i)
})

test("PostHog integration is tenant-admin configured and exposes only an enabled browser configuration", async () => {
  let now = 1_000
  const principals: Record<string, Principal> = {
    admin: {
      tenant_id: "tenant-acme",
      subject_id: "person-admin",
      client_id: "management-ui",
      role: "TENANT_ADMINISTRATOR",
      organization_ids: [],
    },
    user: {
      tenant_id: "tenant-acme",
      subject_id: "person-user",
      client_id: "management-ui",
      role: "USER",
      organization_ids: [],
    },
    other: {
      tenant_id: "tenant-other",
      subject_id: "person-other",
      client_id: "management-ui",
      role: "TENANT_ADMINISTRATOR",
      organization_ids: [],
    },
  }
  const app = Fastify()
  app.decorateRequest("principal", undefined)
  app.addHook("onRequest", async (request) => {
    const authorization = typeof request.headers.authorization === "string"
      ? request.headers.authorization
      : ""
    request.principal = principals[authorization.replace(/^Bearer\s+/, "")]
  })
  app.addHook("preHandler", async (request) => {
    const tenantId = /^\/v1\/tenants\/([^/]+)/.exec(request.url)?.[1]
    if (!tenantId) return
    if (!request.principal) throw new PlatformApiError("UNAUTHENTICATED", 401)
    if (request.principal.tenant_id !== tenantId) {
      throw new PlatformApiError("TENANT_ACCESS_DENIED", 403)
    }
  })
  await app.register(postHogIntegrationHttp, {
    store: createInMemoryPostHogIntegrationStore({ now: () => now }),
  })

  const defaults = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-acme/telemetry/posthog",
    headers: { authorization: "Bearer admin" },
  })
  assert.equal(defaults.statusCode, 200)
  assert.deepEqual(defaults.json(), {
    enabled: false,
    host: null,
    project_id: null,
    project_token: null,
    configured_by: null,
    configured_at: null,
  })

  const browserDisabled = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-acme/telemetry/posthog/browser-configuration",
    headers: { authorization: "Bearer user" },
  })
  assert.equal(browserDisabled.statusCode, 200)
  assert.equal(browserDisabled.headers["cache-control"], "no-store")
  assert.equal(browserDisabled.json(), null)

  const userRead = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-acme/telemetry/posthog",
    headers: { authorization: "Bearer user" },
  })
  assert.equal(userRead.statusCode, 403)
  assert.equal(userRead.json().code, "TENANT_ADMINISTRATOR_REQUIRED")

  const missingBinding = await app.inject({
    method: "PUT",
    url: "/v1/tenants/tenant-acme/telemetry/posthog",
    headers: { authorization: "Bearer admin" },
    payload: {
      enabled: true,
      host: "https://us.i.posthog.com",
      project_id: 7,
    },
  })
  assert.equal(missingBinding.statusCode, 422)
  assert.equal(missingBinding.json().code, "POSTHOG_BROWSER_CONFIGURATION_REQUIRED")

  const partialDisabledBinding = await app.inject({
    method: "PUT",
    url: "/v1/tenants/tenant-acme/telemetry/posthog",
    headers: { authorization: "Bearer admin" },
    payload: {
      enabled: false,
      host: "https://us.i.posthog.com",
      project_id: 7,
    },
  })
  assert.equal(partialDisabledBinding.statusCode, 422)
  assert.equal(partialDisabledBinding.json().code, "POSTHOG_BROWSER_CONFIGURATION_REQUIRED")

  const personalKey = await app.inject({
    method: "PUT",
    url: "/v1/tenants/tenant-acme/telemetry/posthog",
    headers: { authorization: "Bearer admin" },
    payload: {
      enabled: true,
      host: "https://us.i.posthog.com",
      project_id: 7,
      project_token: "phx_personal_key",
    },
  })
  assert.equal(personalKey.statusCode, 400)

  const staged = await app.inject({
    method: "PUT",
    url: "/v1/tenants/tenant-acme/telemetry/posthog",
    headers: { authorization: "Bearer admin" },
    payload: {
      enabled: false,
      host: "https://us.i.posthog.com",
      project_id: 7,
      project_token: "phc_staged_project_token",
    },
  })
  assert.equal(staged.statusCode, 200)
  assert.deepEqual(staged.json(), {
    enabled: false,
    host: "https://us.i.posthog.com",
    project_id: 7,
    project_token: "phc_staged_project_token",
    configured_by: "person-admin",
    configured_at: 1_000,
  })

  const incompleteEnable = await app.inject({
    method: "PUT",
    url: "/v1/tenants/tenant-acme/telemetry/posthog",
    headers: { authorization: "Bearer admin" },
    payload: { enabled: true },
  })
  assert.equal(incompleteEnable.statusCode, 422)
  assert.equal(incompleteEnable.json().code, "POSTHOG_BROWSER_CONFIGURATION_REQUIRED")

  now += 1
  const enabled = await app.inject({
    method: "PUT",
    url: "/v1/tenants/tenant-acme/telemetry/posthog",
    headers: { authorization: "Bearer admin" },
    payload: {
      enabled: true,
      host: "https://eu.i.posthog.com",
      project_id: 7,
      project_token: "phc_browser_project_token",
    },
  })
  assert.equal(enabled.statusCode, 200)
  assert.deepEqual(enabled.json(), {
    enabled: true,
    host: "https://eu.i.posthog.com",
    project_id: 7,
    project_token: "phc_browser_project_token",
    configured_by: "person-admin",
    configured_at: 1_001,
  })

  const browserEnabled = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-acme/telemetry/posthog/browser-configuration",
    headers: { authorization: "Bearer user" },
  })
  assert.equal(browserEnabled.statusCode, 200)
  assert.deepEqual(browserEnabled.json(), {
    enabled: true,
    host: "https://eu.i.posthog.com",
    project_id: 7,
    project_token: "phc_browser_project_token",
  })

  now += 1
  const disabled = await app.inject({
    method: "PUT",
    url: "/v1/tenants/tenant-acme/telemetry/posthog",
    headers: { authorization: "Bearer admin" },
    payload: { enabled: false },
  })
  assert.equal(disabled.statusCode, 200)
  assert.deepEqual(disabled.json(), {
    enabled: false,
    host: "https://eu.i.posthog.com",
    project_id: 7,
    project_token: "phc_browser_project_token",
    configured_by: "person-admin",
    configured_at: 1_002,
  })

  const browserDisabledAfterBinding = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-acme/telemetry/posthog/browser-configuration",
    headers: { authorization: "Bearer user" },
  })
  assert.equal(browserDisabledAfterBinding.statusCode, 200)
  assert.equal(browserDisabledAfterBinding.json(), null)

  const tenantMismatch = await app.inject({
    method: "PUT",
    url: "/v1/tenants/tenant-acme/telemetry/posthog",
    headers: { authorization: "Bearer other" },
    payload: { enabled: false },
  })
  assert.equal(tenantMismatch.statusCode, 403)
  assert.equal(tenantMismatch.json().code, "TENANT_ACCESS_DENIED")

  await app.close()
})

test("PostHog browser configuration accepts an invocation token only for its tenant", async () => {
  const authorization = createManagementAuthorization({
    principalAuthenticator: createStaticPrincipalAuthenticator({
      invocation: {
        tenant_id: "tenant-acme",
        subject_id: "person-bot-user",
        client_id: "genio-one-bot",
        role: "USER",
        organization_ids: [],
        scopes: ["genioone-invocation"],
      },
      other: {
        tenant_id: "tenant-other",
        subject_id: "person-other",
        client_id: "genio-one-bot",
        role: "USER",
        organization_ids: [],
        scopes: ["genioone-invocation"],
      },
    }),
    resourceCatalog: {} as ResourceCatalog,
    endpointRuntime: {} as EndpointRuntimeStore,
    runtimeControl: {} as RuntimeControlStore,
  })
  const app = Fastify()
  app.decorateRequest("principal", undefined)
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof PlatformApiError) {
      return reply.code(error.statusCode).send({ code: error.code })
    }
    return reply.code(500).send({ code: "INTERNAL_ERROR" })
  })
  app.addHook("onRequest", authorization.authenticate)
  app.addHook("preValidation", authorization.normalize)
  app.addHook("preHandler", authorization.authorize)
  await app.register(postHogIntegrationHttp, {
    store: createInMemoryPostHogIntegrationStore(),
  })

  const normalRead = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-acme/telemetry/posthog/browser-configuration",
    headers: { authorization: "Bearer invocation" },
  })
  assert.equal(normalRead.statusCode, 200)
  assert.equal(normalRead.headers["cache-control"], "no-store")
  assert.equal(normalRead.json(), null)

  const managementRead = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-acme/telemetry/posthog",
    headers: { authorization: "Bearer invocation" },
  })
  assert.equal(managementRead.statusCode, 403)
  assert.equal(managementRead.json().code, "INSUFFICIENT_SCOPE")

  const crossTenant = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-acme/telemetry/posthog/browser-configuration",
    headers: { authorization: "Bearer other" },
  })
  assert.equal(crossTenant.statusCode, 403)
  assert.equal(crossTenant.json().code, "TENANT_ACCESS_DENIED")

  await app.close()
})
