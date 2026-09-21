import { afterEach, describe, expect, test } from "bun:test"

import { resolveBotUsageContext, BotUsageContextError } from "./usage-context"
import type { GenioPrincipal } from "./runtime-broker"
import { CE_DEMO_USE_CASE_ID } from "@genioone/protocol/ce-demo"

const principal: GenioPrincipal = {
  tenant_id: "tenant-uat",
  subject_id: "person-dylan",
  acting_client_id: "genio-one-bot",
  organization_ids: ["org-engineering"],
  scopes: ["genioone-invocation"],
}

describe("Bot usage context", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("resolves the single active use case from the verified organization inventory", async () => {
    const seen: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input))
      return new Response(JSON.stringify([{
        tenant_id: "tenant-uat",
        organization_id: "org-engineering",
        use_case_id: "uat-purpose-dylan",
        display_name: "code-debug-document",
        risk_level: "LOW",
        state: "ACTIVE",
        created_at: 1,
      }]), { status: 200 })
    }) as unknown as typeof fetch

    await expect(resolveBotUsageContext({ principal, accessToken: "token" })).resolves.toEqual({
      consumerOrganizationId: "org-engineering",
      useCaseId: "uat-purpose-dylan",
    })
    expect(seen[0]).toContain("/v1/tenants/tenant-uat/organizations/org-engineering/use-cases")
  })

  test("rejects a use case that is not active in the caller organization", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify([{
      tenant_id: "tenant-uat",
      organization_id: "org-engineering",
      use_case_id: "uat-purpose-dylan",
      display_name: "code-debug-document",
      risk_level: "LOW",
      state: "DISABLED",
      created_at: 1,
    }]), { status: 200 })) as unknown as typeof fetch

    await expect(resolveBotUsageContext({ principal, accessToken: "token", useCaseId: "uat-purpose-dylan" })).rejects.toMatchObject({
      code: "USE_CASE_NOT_ALLOWED",
      statusCode: 403,
    } satisfies Partial<BotUsageContextError>)
  })

  test("fails closed when the platform returns a cross-tenant context", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify([{
      tenant_id: "tenant-other",
      organization_id: "org-engineering",
      use_case_id: "uat-purpose-dylan",
      display_name: "code-debug-document",
      state: "ACTIVE",
    }]), { status: 200 })) as unknown as typeof fetch

    await expect(resolveBotUsageContext({ principal, accessToken: "token" })).rejects.toMatchObject({
      code: "USAGE_CONTEXT_LOOKUP_INVALID",
      statusCode: 503,
    } satisfies Partial<BotUsageContextError>)
  })

  test("resolves the installed CE demo organization for a Tenant Administrator with no organization claim", async () => {
    const seen: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      seen.push(url)
      if (url.includes("/v1/tenants/tenant-uat/demo-project")) {
        return Response.json({ installation: "INSTALLED", organization_id: "org-ce-demo" })
      }
      if (url.includes("/v1/tenants/tenant-uat/organizations/org-ce-demo/use-cases")) {
        return Response.json([{
          tenant_id: "tenant-uat",
          organization_id: "org-ce-demo",
          use_case_id: CE_DEMO_USE_CASE_ID,
          display_name: "CE 示範專案",
          state: "ACTIVE",
        }])
      }
      return new Response("not found", { status: 404 })
    }) as unknown as typeof fetch

    await expect(resolveBotUsageContext({
      principal: { ...principal, role: "TENANT_ADMINISTRATOR", organization_ids: [] },
      accessToken: "token",
      useCaseId: CE_DEMO_USE_CASE_ID,
    })).resolves.toEqual({ consumerOrganizationId: "org-ce-demo", useCaseId: CE_DEMO_USE_CASE_ID })
    expect(seen).toEqual([
      "http://127.0.0.1:58082/v1/tenants/tenant-uat/demo-project",
      "http://127.0.0.1:58082/v1/tenants/tenant-uat/organizations/org-ce-demo/use-cases",
    ])
  })

  test("does not use the CE installation to authorize another actor or use case", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Response("unexpected", { status: 500 })
    }) as unknown as typeof fetch

    await expect(resolveBotUsageContext({
      principal: { ...principal, role: "ORGANIZATION_ADMINISTRATOR", organization_ids: [] },
      accessToken: "token",
      useCaseId: CE_DEMO_USE_CASE_ID,
    })).rejects.toMatchObject({ code: "USE_CASE_NOT_ALLOWED", statusCode: 403 } satisfies Partial<BotUsageContextError>)
    await expect(resolveBotUsageContext({
      principal: { ...principal, role: "TENANT_ADMINISTRATOR", organization_ids: [] },
      accessToken: "token",
      useCaseId: "forged-use-case",
    })).rejects.toMatchObject({ code: "USE_CASE_NOT_ALLOWED", statusCode: 403 } satisfies Partial<BotUsageContextError>)
    expect(calls).toBe(0)
  })
})
