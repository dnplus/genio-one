import { expect, test } from "bun:test"

import { listPersonalMemoryAgents, type PersonalMemoryAgentGrant } from "@/lib/self-service-api"

function grant(index: number, revoked = false): PersonalMemoryAgentGrant {
  return {
    tenant_id: "tenant/acme",
    owner_subject_id: "person-user",
    agent_id: `agent-${index}`,
    grant_id: `grant-${index}`,
    enabled_at: 1_000 - index,
    revoked_at: revoked ? 2_000 : null,
  }
}

test("personal memory Agent listing completes all pages and preserves revocation history without duplicates", async () => {
  const originalFetch = globalThis.fetch
  const requests: Array<{ url: URL; token: string | null }> = []
  const firstPage = Array.from({ length: 100 }, (_, index) => grant(index, index < 99))
  const lateActiveGrant = grant(100)
  const lateRevokedGrant = grant(101, true)
  const cursor = "opaque+/cursor="
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost")
    requests.push({ url, token: new Headers(init?.headers).get("authorization") })
    return Response.json(url.searchParams.has("cursor")
      ? { agents: [firstPage[99], lateActiveGrant, lateRevokedGrant], next_cursor: null }
      : { agents: firstPage, next_cursor: cursor })
  }, { preconnect: originalFetch.preconnect })

  try {
    const result = await listPersonalMemoryAgents("owner-token", "tenant/acme")
    expect(result.agents).toHaveLength(102)
    expect(result.agents.filter((entry) => entry.revoked_at === null)).toEqual([firstPage[99], lateActiveGrant])
    expect(result.agents.at(-1)).toEqual(lateRevokedGrant)
    expect(requests).toHaveLength(2)
    expect(requests.map((request) => request.url.pathname)).toEqual([
      "/v1/tenants/tenant%2Facme/me/memory-agents",
      "/v1/tenants/tenant%2Facme/me/memory-agents",
    ])
    expect(requests.map((request) => request.url.searchParams.get("limit"))).toEqual(["100", "100"])
    expect(requests.map((request) => request.url.searchParams.get("cursor"))).toEqual([null, cursor])
    expect(requests.map((request) => request.token)).toEqual(["Bearer owner-token", "Bearer owner-token"])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("personal memory Agent listing reports a later-page error without returning a partial list", async () => {
  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = Object.assign(async (_input: Parameters<typeof fetch>[0]) => {
    requests += 1
    return requests === 1
      ? Response.json({ agents: [grant(0)], next_cursor: "invalid-cursor" })
      : Response.json({ code: "MEMORY_AGENT_CURSOR_INVALID" }, { status: 422 })
  }, { preconnect: originalFetch.preconnect })

  try {
    await expect(listPersonalMemoryAgents("owner-token", "tenant/acme")).rejects.toThrow("MEMORY_AGENT_CURSOR_INVALID")
    expect(requests).toBe(2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("personal memory Agent listing stops when the server repeats a cursor", async () => {
  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = Object.assign(async (_input: Parameters<typeof fetch>[0]) => {
    requests += 1
    return Response.json({ agents: [grant(0)], next_cursor: "repeated-cursor" })
  }, { preconnect: originalFetch.preconnect })

  try {
    await expect(listPersonalMemoryAgents("owner-token", "tenant/acme")).rejects.toThrow("MEMORY_AGENT_CURSOR_INVALID")
    expect(requests).toBe(2)
  } finally {
    globalThis.fetch = originalFetch
  }
})
