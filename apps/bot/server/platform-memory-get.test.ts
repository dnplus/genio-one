import { expect, test } from "bun:test"
import { getPlatformPersonalMemory, PlatformMemoryUnavailableError } from "./platform-memory"

type Principal = { tenant_id: string; subject_id: string; acting_client_id: string; scopes: string[] }

test("memory_get reads the exact owner personal record and rejects malformed read-back data", async () => {
  const owner: Principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: ["genioone-invocation"] }
  const valid: Record<string, unknown> = {
    memory_id: "memory-1",
    tenant_id: owner.tenant_id,
    scope: "PERSONAL",
    owner_subject_id: owner.subject_id,
    team_id: null,
    organization_id: null,
    key: "偏好",
    kind: "preference",
    context: { kind: "GLOBAL", context_id: null },
    content: "使用臺灣繁體中文",
    assertion_origin: "AGENT_INFERRED",
    source: {
      actor_subject_id: owner.subject_id,
      client_id: owner.acting_client_id,
      agent_id: owner.acting_client_id,
      agent_grant_id: "grant-owner",
      reference_id: "legacy-bot-memory:bot-1:legacy-1",
    },
    revision: 1,
    created_at: 1,
    updated_at: 1,
  }
  const originalFetch = globalThis.fetch
  const originalPlatformOrigin = process.env.GENIO_ONE_PLATFORM_ORIGIN
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  let current = valid
  process.env.GENIO_ONE_PLATFORM_ORIGIN = "http://platform.test"
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname === "/v1/identity/session") return Response.json(owner)
    const request = typeof init?.body === "string" ? JSON.parse(init.body) as { params?: { name?: unknown; arguments?: unknown } } : {}
    const name = typeof request.params?.name === "string" ? request.params.name : ""
    const args = request.params?.arguments && typeof request.params.arguments === "object" && !Array.isArray(request.params.arguments)
      ? request.params.arguments as Record<string, unknown>
      : {}
    calls.push({ name, args })
    return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(current) }], structuredContent: current } })
  }) as typeof fetch

  try {
    await expect(getPlatformPersonalMemory({ principal: owner, accessToken: "owner-token", memoryId: "memory-1" })).resolves.toMatchObject({
      id: "memory-1",
      revision: 1,
      content: "使用臺灣繁體中文",
      source: { referenceId: "legacy-bot-memory:bot-1:legacy-1" },
    })
    const invalidRecords = [
      { ...valid, tenant_id: "another-tenant" },
      { ...valid, owner_subject_id: "another-owner" },
      { ...valid, memory_id: "memory-2" },
      { ...valid, revision: 0 },
      { ...valid, content: "" },
      { ...valid, source: { ...(valid.source as Record<string, unknown>), client_id: "" } },
    ]
    for (const invalid of invalidRecords) {
      current = invalid
      await expect(getPlatformPersonalMemory({ principal: owner, accessToken: "owner-token", memoryId: "memory-1" })).rejects.toBeInstanceOf(PlatformMemoryUnavailableError)
    }
    expect(calls).toEqual(Array.from({ length: 7 }, () => ({ name: "memory_get", args: { memory_id: "memory-1" } })))
  } finally {
    globalThis.fetch = originalFetch
    if (originalPlatformOrigin === undefined) delete process.env.GENIO_ONE_PLATFORM_ORIGIN
    else process.env.GENIO_ONE_PLATFORM_ORIGIN = originalPlatformOrigin
  }
})
