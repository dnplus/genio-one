import assert from "node:assert/strict"
import test from "node:test"

import {
  getGetRuntimePolicyDraftUrl,
  getGetV1TenantsTenantIdOnePolicyFirstPartyBotDraftUrl,
  getGetV1TenantsTenantIdResourcesResourceIdCapabilitiesCapabilityIdPolicyDraftUrl,
  saveAccessGroup,
} from "@/generated/management-api"
import { ProductApiError, managementApiFetch, requestJson } from "@/lib/management-api-transport"

test("management API transport preserves generated content headers and adds management authentication", async () => {
  const originalFetch = globalThis.fetch
  const originalSessionStorage = globalThis.sessionStorage
  let request: { url: string; method: string; authorization: string | null; accept: string | null; contentType: string | null; body: string | null } | null = null

  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: { getItem: () => "management-token" },
  })
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    request = {
      url: input instanceof Request ? input.url : String(input),
      method: init?.method ?? "GET",
      authorization: new Headers(init?.headers).get("authorization"),
      accept: new Headers(init?.headers).get("accept"),
      contentType: new Headers(init?.headers).get("content-type"),
      body: typeof init?.body === "string" ? init.body : null,
    }
    return new Response(JSON.stringify({ accepted: true }), { headers: { "content-type": "application/json" }, status: 200 })
  }) as typeof fetch

  try {
    const result = await managementApiFetch<{ data: { accepted: boolean }; status: number; headers: Headers }>("/v1/tenants/tenant%20one/access-groups", {
      method: "PUT",
      headers: { "content-type": "application/problem+json" },
      body: "{}",
    })

    assert.deepEqual(result.data, { accepted: true })
    assert.equal(result.status, 200)
    assert.deepEqual(request, {
      url: "/v1/tenants/tenant%20one/access-groups",
      method: "PUT",
      authorization: "Bearer management-token",
      accept: "application/json",
      contentType: "application/problem+json",
      body: "{}",
    })
  } finally {
    globalThis.fetch = originalFetch
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: originalSessionStorage,
    })
  }
})

test("management API transport reports product errors with violations", async () => {
  const originalFetch = globalThis.fetch
  const originalSessionStorage = globalThis.sessionStorage

  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: { getItem: () => null },
  })
  globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
    code: "POLICY_DRAFT_CONFLICT",
    violations: [{ code: "EXPECTED_VERSION", message: "Draft version changed", field: "expected_version" }],
  }), { headers: { "content-type": "application/json" }, status: 409 })) as typeof fetch

  try {
    await assert.rejects(
      requestJson("/v1/tenants/tenant-one/one-policy/runtime-policies/policy-one/draft"),
      (error: unknown) => error instanceof ProductApiError && error.status === 409 && error.message === "POLICY_DRAFT_CONFLICT" && error.violations[0]?.field === "expected_version",
    )
  } finally {
    globalThis.fetch = originalFetch
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: originalSessionStorage,
    })
  }
})

test("generated management operations encode identifiers and use the authenticated transport", async () => {
  const originalFetch = globalThis.fetch
  const originalSessionStorage = globalThis.sessionStorage
  let request: { url: string; authorization: string | null } | null = null

  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: { getItem: () => "management-token" },
  })
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    request = {
      url: input instanceof Request ? input.url : String(input),
      authorization: new Headers(init?.headers).get("authorization"),
    }
    return new Response(JSON.stringify({
      tenant_id: "tenant /one",
      access_group_id: "group /one",
      display_name: "Operators",
      description: "",
      enabled: true,
      revision: 1,
      membership_sources: [],
      created_at: 1,
      created_by: "subject-admin",
      updated_at: 1,
      updated_by: "subject-admin",
    }), { headers: { "content-type": "application/json" }, status: 200 })
  }) as typeof fetch

  try {
    assert.equal(getGetV1TenantsTenantIdOnePolicyFirstPartyBotDraftUrl("tenant /one"), "/v1/tenants/tenant%20%2Fone/one-policy/first-party-bot/draft")
    assert.equal(getGetV1TenantsTenantIdResourcesResourceIdCapabilitiesCapabilityIdPolicyDraftUrl("tenant /one", "resource /one", "capability /one"), "/v1/tenants/tenant%20%2Fone/resources/resource%20%2Fone/capabilities/capability%20%2Fone/policy-draft")
    assert.equal(getGetRuntimePolicyDraftUrl("tenant /one", "policy /one"), "/v1/tenants/tenant%20%2Fone/one-policy/runtime-policies/policy%20%2Fone/draft")

    const response = await saveAccessGroup("tenant /one", "group /one", {
      expected_revision: 0,
      display_name: "Operators",
      description: "",
      enabled: true,
    })

    assert.equal(response.data.access_group_id, "group /one")
    assert.deepEqual(request, {
      url: "/v1/tenants/tenant%20%2Fone/access-groups/group%20%2Fone",
      authorization: "Bearer management-token",
    })
  } finally {
    globalThis.fetch = originalFetch
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: originalSessionStorage,
    })
  }
})
