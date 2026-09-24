import assert from "node:assert/strict"
import test from "node:test"

import { createMockOverview } from "@/mocks/overview"
import {
  grantEntitlement,
  installDemoProject,
  listTraces,
  loadDemoProject,
  loadOverview,
  skipDemoProject,
} from "@/lib/product-api"

function responseFor(url: string): unknown {
  if (url.includes("/ai-activities?")) return { resources: [], recent_activity: [] }
  if (url.includes("/api-activities?")) return { events: [] }
  if (url.includes("/ai-usage?")) return null
  if (url.includes("/metrics?")) return null
  if (url.endsWith("/siem-destination")) return null
  if (url.endsWith("/identity")) return null
  if (url.endsWith("/organizations")) {
    return [{
      tenant_id: "tenant-policy-truth",
      organization_id: "organization-platform",
      display_name: "Platform Engineering",
      slug: "platform-engineering",
      member_subject_ids: ["subject-admin"],
      organization_administrator_subject_ids: ["subject-admin"],
      membership_sources: [{ kind: "MANUAL", reference: "console", status: "SYNCED" }],
      created_at: 1,
    }]
  }
  if (url.endsWith("/gateway-sites")) return null
  if (url === "/healthz") return { status: "ok" }
  return []
}

test("overview requests Access Groups for management administrators and keeps authorized failures visible", async () => {
  const originalFetch = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input)
    urls.push(url)
    return new Response(JSON.stringify(url.endsWith("/access-groups") ? { code: "DIRECTORY_UNAVAILABLE" } : responseFor(url)), {
      headers: { "content-type": "application/json" },
      status: url.endsWith("/access-groups") ? 503 : 200,
    })
  }) as typeof fetch
  try {
    for (const role of [undefined, "USER"] as const) {
      urls.length = 0
      const overview = await loadOverview("tenant-acme", role)
      assert.equal(urls.some((url) => url.endsWith("/access-groups")), false)
      assert.equal(overview.failures.some((failure) => failure.source === "Access groups"), false)
    }
    urls.length = 0
    const organizationAdminOverview = await loadOverview("tenant-acme", "ORGANIZATION_ADMINISTRATOR")
    assert.equal(urls.some((url) => url.endsWith("/access-groups")), true)
    assert.equal(organizationAdminOverview.failures.some((failure) => failure.source === "Access groups"), true)
    urls.length = 0
    const overview = await loadOverview("tenant-acme", "TENANT_ADMINISTRATOR")
    assert.equal(urls.some((url) => url.endsWith("/access-groups")), true)
    assert.equal(overview.failures.some((failure) => failure.source === "Access groups"), true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("live and mock overview omit legacy policy authority", async () => {
  const originalFetch = globalThis.fetch
  const originalSessionStorage = globalThis.sessionStorage
  const requestedUrls: string[] = []

  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: { getItem: () => null },
  })
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input)
    requestedUrls.push(url)
    return new Response(JSON.stringify(responseFor(url)), {
      headers: { "content-type": "application/json" },
      status: 200,
    })
  }) as typeof fetch

  try {
    const live = await loadOverview("tenant-policy-truth")
    const mock = createMockOverview()

    assert.equal("policies" in live, false)
    assert.equal("policyProposals" in live, false)
    assert.equal("policies" in mock, false)
    assert.equal("policyProposals" in mock, false)
    assert.equal(requestedUrls.some((url) => url.includes("policy-proposals")), false)
    assert.equal("teams" in live, false)
    assert.equal("teams" in mock, false)
    assert.deepEqual(live.organizations[0], {
      tenant_id: "tenant-policy-truth",
      organization_id: "organization-platform",
      display_name: "Platform Engineering",
      slug: "platform-engineering",
      member_subject_ids: ["subject-admin"],
      organization_administrator_subject_ids: ["subject-admin"],
      membership_sources: [{ kind: "MANUAL", reference: "console", status: "SYNCED" }],
      created_at: 1,
    })
  } finally {
    globalThis.fetch = originalFetch
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: originalSessionStorage,
    })
  }
})

test("overview keeps a Resource capability inventory independent from owned Entitlements", async () => {
  const originalFetch = globalThis.fetch
  const originalSessionStorage = globalThis.sessionStorage
  const capabilities = [
    { capability_id: "ticket.already-granted", display_name: "Already granted" },
    { capability_id: "ticket.available", display_name: "Still available" },
  ]

  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: { getItem: () => "management-token" },
  })
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input)
    const payload = url.endsWith("/resources")
      ? [{
        tenant_id: "tenant-acme",
        resource_id: "resource-support",
        display_name: "Published support resource",
        kind: "MCP",
        owner_organization_id: "organization-acme",
        authentication_strategy: "NONE",
        environment_id: "production",
        version: "1.0.0",
        lifecycle: "PUBLISHED",
        operational_state: "HEALTHY",
        capabilities,
        enforcement_point_id: "gateway-acme",
        created_at: 100,
      }]
      : url.endsWith("/connections")
        ? [{ ...createMockOverview().connections[0], resource_id: "resource-support", endpoint: "https://support.example.test", status: "DEGRADED" }]
      : url.endsWith("/me/owned-entitlements")
        ? [{
          entitlement_id: "entitlement-1",
          subject_id: "subject-ada",
          resource_id: "resource-support",
          capability_id: "ticket.already-granted",
          state: "ACTIVE",
          starts_at: 100,
          expires_at: null,
        }]
        : responseFor(url)
    return new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json" },
      status: 200,
    })
  }) as typeof fetch

  try {
    const overview = await loadOverview("tenant-acme")

    assert.deepEqual(overview.resources[0]?.capabilities, capabilities)
    assert.equal(overview.ownedEntitlements[0]?.capability_id, "ticket.already-granted")
    assert.equal(overview.connections[0]?.status, "DEGRADED")
  } finally {
    globalThis.fetch = originalFetch
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: originalSessionStorage,
    })
  }
})

test("Demo Project uses the tenant-scoped status, install, and skip contract", async () => {
  const originalFetch = globalThis.fetch
  const originalSessionStorage = globalThis.sessionStorage
  const requests: Array<{ url: string; method: string; body: string | null }> = []

  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: { getItem: () => null },
  })
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: input instanceof Request ? input.url : String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
    })
    return new Response(JSON.stringify({
      demo_id: "ce-starter",
      version: "1.0.0",
      installation: "NOT_INSTALLED",
      organization_id: null,
      items: [],
      prompts: [],
      package_resource_id: "ce-starter-package",
      bot_url: null,
    }), { headers: { "content-type": "application/json" }, status: 200 })
  }) as typeof fetch

  try {
    await loadDemoProject("tenant /demo")
    await installDemoProject("tenant /demo", "organization /demo")
    await skipDemoProject("tenant /demo")

    assert.deepEqual(requests, [
      { url: "/v1/tenants/tenant%20%2Fdemo/demo-project", method: "GET", body: null },
      { url: "/v1/tenants/tenant%20%2Fdemo/demo-project/install", method: "POST", body: "{\"organization_id\":\"organization /demo\"}" },
      { url: "/v1/tenants/tenant%20%2Fdemo/demo-project/skip", method: "POST", body: null },
    ])
  } finally {
    globalThis.fetch = originalFetch
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: originalSessionStorage,
    })
  }
})

test("Grant Entitlement sends one stable retry request identity", async () => {
  const originalFetch = globalThis.fetch
  const originalSessionStorage = globalThis.sessionStorage
  let request: { url: string; method: string; idempotencyKey: string | null; body: string | null } | null = null

  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: { getItem: () => null },
  })
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    request = {
      url: input instanceof Request ? input.url : String(input),
      method: init?.method ?? "GET",
      idempotencyKey: new Headers(init?.headers).get("idempotency-key"),
      body: typeof init?.body === "string" ? init.body : null,
    }
    return new Response("{}", { headers: { "content-type": "application/json" }, status: 201 })
  }) as typeof fetch

  try {
    await grantEntitlement("tenant /demo", {
      subjectId: "subject /ada",
      resourceId: "resource /support",
      capabilityId: "ticket.create",
      idempotencyKey: "grant-retry-1",
    })

    assert.deepEqual(request, {
      url: "/v1/tenants/tenant%20%2Fdemo/entitlements",
      method: "POST",
      idempotencyKey: "grant-retry-1",
      body: "{\"subject_id\":\"subject /ada\",\"resource_id\":\"resource /support\",\"capability_id\":\"ticket.create\",\"public_model_id\":null}",
    })
  } finally {
    globalThis.fetch = originalFetch
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: originalSessionStorage,
    })
  }
})

test("listTraces sends correlation_id separately from generic search", async () => {
  const originalFetch = globalThis.fetch
  let requestedUrl = ""
  globalThis.fetch = (async (input: string | URL | Request) => {
    requestedUrl = input instanceof Request ? input.url : String(input)
    return new Response(JSON.stringify({ traces: [] }), { headers: { "content-type": "application/json" }, status: 200 })
  }) as typeof fetch

  try {
    await listTraces("tenant /trace", 20, { correlation_id: "canonical /correlation", search: "gateway" })
    const url = new URL(requestedUrl, "http://platform.test")
    assert.equal(url.searchParams.get("correlation_id"), "canonical /correlation")
    assert.equal(url.searchParams.get("search"), "gateway")
  } finally {
    globalThis.fetch = originalFetch
  }
})
