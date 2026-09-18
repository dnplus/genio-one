import { afterEach, describe, expect, mock, test } from "bun:test"

import { ensureAgentSubject } from "./agent-subject"
import type { GenioPrincipal } from "./runtime-broker"

const principal: GenioPrincipal = {
  tenant_id: "tenant-acme",
  subject_id: "person-admin",
  acting_client_id: "genio-one-bot",
  role: "TENANT_ADMINISTRATOR",
  scopes: ["genioone-management", "genioone-invocation"],
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("agent subject registration", () => {
  test("fails closed in development when registration is unavailable", async () => {
    globalThis.fetch = mock(async () => { throw new Error("platform unavailable") }) as unknown as typeof fetch
    await expect(ensureAgentSubject({ principal, accessToken: "token", displayName: "Ops Bot" }, { NODE_ENV: "development", GENIO_ONE_PLATFORM_ORIGIN: "http://platform.test" })).rejects.toThrow("platform unavailable")
  })

  test("fails closed in production when credentials are missing", async () => {
    await expect(ensureAgentSubject({ principal: { ...principal, role: "USER" }, accessToken: "", displayName: "Ops Bot" }, { NODE_ENV: "production", GENIO_ONE_PLATFORM_ORIGIN: "http://127.0.0.1:1" })).rejects.toThrow("AGENT_SUBJECT_REGISTRATION_REQUIRED:missing_credentials")
  })

  test("surfaces forbidden status instead of opaque REGISTRATION_REQUIRED", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ error: "insufficient_scope" }), { status: 403, statusText: "Forbidden" }),
    ) as unknown as typeof fetch

    await expect(ensureAgentSubject({
      principal,
      accessToken: "user-token-without-management",
      displayName: "Ops Bot",
    }, {
      NODE_ENV: "production",
      GENIO_ONE_PLATFORM_ORIGIN: "http://platform.test",
    })).rejects.toThrow("AGENT_SUBJECT_CREATE_FORBIDDEN:403:insufficient_scope")
  })

  test("does not replace a self-service denial with a local fixture", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ code: "BOT_ACCESS_DENIED" }), { status: 403, statusText: "Forbidden" }),
    ) as unknown as typeof fetch

    await expect(ensureAgentSubject({
      principal: { ...principal, role: "USER" },
      accessToken: "user-token",
      displayName: "Ops Bot",
    }, {
      NODE_ENV: "development",
      GENIO_ONE_PLATFORM_ORIGIN: "http://platform.test",
    })).rejects.toThrow("AGENT_SUBJECT_CREATE_FORBIDDEN:403:BOT_ACCESS_DENIED")
  })

  test("registers via control plane when platform accepts the token", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ subject_id: "agent-cp-1", kind: "AGENT" }), { status: 201 }),
    ) as unknown as typeof fetch

    const result = await ensureAgentSubject({
      principal,
      accessToken: "admin-token",
      displayName: "Ops Bot",
    }, {
      NODE_ENV: "production",
      GENIO_ONE_PLATFORM_ORIGIN: "http://platform.test",
    })
    expect(result).toEqual({ subjectId: "agent-cp-1", mode: "control-plane" })
  })

  test("uses the current user's token and self-service body", async () => {
    const calls: Array<{ url: string; authorization: string; body: unknown }> = []
    globalThis.fetch = mock(async (url, init) => {
      const headers = init?.headers as Record<string, string>
      calls.push({ url: String(url), authorization: headers.authorization, body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify({ subject_id: "agent-user-1", kind: "AGENT" }), { status: 201 })
    }) as unknown as typeof fetch

    const result = await ensureAgentSubject({
      principal: { ...principal, role: "USER", subject_id: "person-user" },
      accessToken: "user-token",
      displayName: "Ops Bot",
    }, {
      NODE_ENV: "production",
      GENIO_ONE_PLATFORM_ORIGIN: "http://platform.test",
      GENIO_ONE_AGENT_SUBJECT_SERVICE_TOKEN: "service-token-must-not-be-used",
    })
    expect(result.subjectId).toBe("agent-user-1")
    expect(calls).toEqual([{
      url: "http://platform.test/v1/tenants/tenant-acme/me/agents",
      authorization: "Bearer user-token",
      body: { display_name: "Ops Bot" },
    }])
  })
})
