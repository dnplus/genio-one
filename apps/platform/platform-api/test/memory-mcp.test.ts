import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"

import { createManagementApi } from "../src/app"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"
import type { Principal } from "../src/capabilities/tenancy-auth/contract"

const tenantId = "tenant-memory-mcp"
const otherTenantId = "tenant-memory-mcp-other"
const ownerId = "person-memory-owner"
const otherOwnerId = "person-memory-other"
const idempotencyKeys = new Map<string, string>()

function idempotencyKey(label: string): string {
  const existing = idempotencyKeys.get(label)
  if (existing) return existing
  const value = randomUUID()
  idempotencyKeys.set(label, value)
  return value
}

function principal(input: {
  tenantId?: string
  subjectId?: string
  clientId?: string
  scopes?: string[]
} = {}): Principal {
  return {
    tenant_id: input.tenantId ?? tenantId,
    subject_id: input.subjectId ?? ownerId,
    client_id: input.clientId ?? "genio-one-self-service",
    role: "USER",
    organization_ids: [],
    ...(input.scopes === undefined ? {} : { scopes: input.scopes }),
  }
}

async function fixture() {
  const modules = createInMemoryPlatformModules({ now: () => 1_000 })
  await modules.identity.bootstrap({
    tenantId,
    subjects: [
      { subject_id: ownerId, kind: "PERSON" },
      { subject_id: otherOwnerId, kind: "PERSON" },
      { subject_id: "agent-subject", kind: "AGENT" },
    ],
  })
  await modules.identity.bootstrap({
    tenantId: otherTenantId,
    subjects: [{ subject_id: ownerId, kind: "PERSON" }],
  })
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      owner: principal({ scopes: ["genioone-invocation"] }),
      "agent-a": principal({ clientId: "agent-a", scopes: ["genioone-invocation"] }),
      "agent-b": principal({ clientId: "agent-b", scopes: ["genioone-invocation"] }),
      other: principal({ subjectId: otherOwnerId, scopes: ["genioone-invocation"] }),
      "other-tenant": principal({ tenantId: otherTenantId, scopes: ["genioone-invocation"] }),
      "wrong-client": principal({ clientId: "third-party-client", scopes: ["genioone-invocation"] }),
      "missing-scope": principal(),
      "management-only": principal({ scopes: ["genioone-management"] }),
      "agent-subject": principal({ subjectId: "agent-subject", scopes: ["genioone-invocation"] }),
    }),
  })
  const ownerHeaders = { authorization: "Bearer owner", "content-type": "application/json" }
  const memoriesUrl = `/v1/tenants/${tenantId}/me/memories`
  const agentsUrl = `/v1/tenants/${tenantId}/me/memory-agents`
  const mcp = (token: string, body: unknown, requestedTenant = tenantId) => app.inject({
    method: "POST",
    url: `/v1/tenants/${requestedTenant}/memory/mcp`,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    payload: JSON.stringify(body),
  })
  return { app, ownerHeaders, memoriesUrl, agentsUrl, mcp }
}

function initialize() {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "memory-mcp-test", version: "1" },
    },
  }
}

test("personal memory HTTP and MCP use the verified owner, active per-client grant, and AsAgent operations", async () => {
  const { app, ownerHeaders, memoriesUrl, agentsUrl, mcp } = await fixture()
  try {
    const beforeGrant = await mcp("agent-a", initialize())
    expect(beforeGrant.statusCode).toBe(403)
    expect(beforeGrant.body).toContain("MEMORY_AGENT_GRANT_INVALID")

    const enabled = await app.inject({
      method: "POST",
      url: agentsUrl,
      headers: ownerHeaders,
      payload: { agent_id: "agent-a" },
    })
    expect(enabled.statusCode).toBe(201)
    expect(enabled.json().agent_id).toBe("agent-a")

    const initialized = await mcp("agent-a", initialize())
    expect(initialized.statusCode).toBe(200)
    expect(initialized.json().result.serverInfo.name).toBe("genio-one-memory")
    expect(initialized.headers["cache-control"]).toBe("no-store")
    expect(initialized.headers["x-request-id"]).toBeTruthy()

    const tools = await mcp("agent-a", { jsonrpc: "2.0", id: 2, method: "tools/list" })
    expect(tools.statusCode).toBe(200)
    expect(tools.json().result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "memory_list",
      "memory_retrieve",
      "memory_get",
      "memory_remember",
      "memory_forget",
      "memory_scope_list",
    ])

    const remembered = await mcp("agent-a", {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "memory_remember",
        arguments: {
          expected_revision: 0,
          idempotency_key: idempotencyKey("agent-remembers-timezone"),
          key: "timezone",
          kind: "preference",
          content: "使用 Asia/Taipei 顯示未來排程。",
        },
      },
    })
    expect(remembered.statusCode).toBe(200)
    const memory = remembered.json().result.structuredContent
    expect(memory.owner_subject_id).toBe(ownerId)
    expect(memory.assertion_origin).toBe("AGENT_INFERRED")
    expect(memory.source.agent_id).toBe("agent-a")
    expect(memory.source.agent_grant_id).toBe(enabled.json().grant_id)

    const enabledSecondAgent = await app.inject({
      method: "POST",
      url: agentsUrl,
      headers: ownerHeaders,
      payload: { agent_id: "agent-b" },
    })
    expect(enabledSecondAgent.statusCode).toBe(201)

    const secondInitialized = await mcp("agent-b", initialize())
    expect(secondInitialized.statusCode).toBe(200)

    const listed = await mcp("agent-a", {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "memory_list", arguments: {} },
    })
    expect(listed.json().result.structuredContent.memories).toHaveLength(1)

    const retrieved = await mcp("agent-a", {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "memory_retrieve", arguments: { query: "Taipei" } },
    })
    expect(retrieved.json().result.structuredContent.context).toContain("Asia/Taipei")

    const got = await mcp("agent-a", {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "memory_get", arguments: { memory_id: memory.memory_id } },
    })
    expect(got.json().result.structuredContent.memory_id).toBe(memory.memory_id)

    const secondRetrieved = await mcp("agent-b", {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "memory_retrieve", arguments: { query: "Taipei" } },
    })
    expect(secondRetrieved.json().result.structuredContent.memories[0].memory_id).toBe(memory.memory_id)

    const secondGot = await mcp("agent-b", {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "memory_get", arguments: { memory_id: memory.memory_id } },
    })
    expect(secondGot.json().result.structuredContent.memory_id).toBe(memory.memory_id)

    const revoked = await app.inject({
      method: "DELETE",
      url: `${agentsUrl}/agent-a`,
      headers: { authorization: "Bearer owner" },
    })
    expect(revoked.statusCode, revoked.body).toBe(200)
    expect(revoked.json().revoked_at).not.toBeNull()

    const afterRevoke = await mcp("agent-a", { jsonrpc: "2.0", id: 9, method: "tools/list" })
    expect(afterRevoke.statusCode).toBe(403)
    expect(afterRevoke.body).toContain("MEMORY_AGENT_GRANT_INVALID")

    const retainedForSecondAgent = await mcp("agent-b", {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "memory_get", arguments: { memory_id: memory.memory_id } },
    })
    expect(retainedForSecondAgent.json().result.structuredContent.memory_id).toBe(memory.memory_id)

    const forgotten = await mcp("agent-b", {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "memory_forget",
        arguments: {
          memory_id: memory.memory_id,
          expected_revision: memory.revision,
          idempotency_key: idempotencyKey("agent-forgets-timezone"),
        },
      },
    })
    expect(forgotten.json().result.structuredContent.memory_id).toBe(memory.memory_id)

    const missing = await mcp("agent-b", {
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "memory_get", arguments: { memory_id: memory.memory_id } },
    })
    expect(missing.json().result.isError).toBe(true)
    expect(missing.body).toContain("MEMORY_NOT_FOUND")

    const direct = await app.inject({
      method: "POST",
      url: memoriesUrl,
      headers: ownerHeaders,
      payload: {
        expected_revision: 0,
        idempotency_key: idempotencyKey("owner-direct-memory"),
        key: "language",
        kind: "preference",
        content: "使用台灣繁體中文。",
      },
    })
    expect(direct.statusCode).toBe(201)
    expect(direct.json().assertion_origin).toBe("USER_EXPLICIT")

    const directRead = await app.inject({
      method: "GET",
      url: `${memoriesUrl}/${direct.json().memory_id}`,
      headers: { authorization: "Bearer owner" },
    })
    expect(directRead.statusCode).toBe(200)
    expect(directRead.json().memory_id).toBe(direct.json().memory_id)

    const directDeleted = await app.inject({
      method: "DELETE",
      url: `${memoriesUrl}/${direct.json().memory_id}`,
      headers: ownerHeaders,
      payload: {
        expected_revision: direct.json().revision,
        idempotency_key: idempotencyKey("owner-deletes-direct-memory"),
      },
    })
    expect(directDeleted.statusCode).toBe(200)
    expect(directDeleted.json().memory_id).toBe(direct.json().memory_id)
  } finally {
    await app.close()
  }
})

test("personal memory only accepts UUIDv4 idempotency keys", async () => {
  const { app, ownerHeaders, memoriesUrl } = await fixture()
  try {
    const response = await app.inject({
      method: "POST",
      url: memoriesUrl,
      headers: ownerHeaders,
      payload: {
        expected_revision: 0,
        idempotency_key: "legacy-memory-request",
        key: "timezone",
        kind: "preference",
        content: "Use Asia/Taipei.",
      },
    })
    expect(response.statusCode).toBe(400)
    expect(response.body).toContain("REQUEST_VALIDATION_FAILED")
  } finally {
    await app.close()
  }
})

test("personal memory agent list is owner-scoped, paginated, and includes revoked grants", async () => {
  const { app, ownerHeaders, agentsUrl } = await fixture()
  try {
    for (const agentId of ["agent-a", "agent-b"]) {
      const enabled = await app.inject({
        method: "POST",
        url: agentsUrl,
        headers: ownerHeaders,
        payload: { agent_id: agentId },
      })
      expect(enabled.statusCode).toBe(201)
    }
    const revoked = await app.inject({
      method: "DELETE",
      url: agentsUrl + "/agent-a",
      headers: { authorization: "Bearer owner" },
    })
    expect(revoked.statusCode).toBe(200)

    const first = await app.inject({
      method: "GET",
      url: agentsUrl + "?limit=1",
      headers: { authorization: "Bearer owner" },
    })
    expect(first.statusCode).toBe(200)
    expect(first.json().agents).toHaveLength(1)
    expect(first.json().agents[0].agent_id).toBe("agent-a")
    expect(first.json().agents[0].revoked_at).not.toBeNull()
    expect(first.json().next_cursor).toBeTruthy()

    const second = await app.inject({
      method: "GET",
      url: agentsUrl + "?limit=1&cursor=" + encodeURIComponent(first.json().next_cursor),
      headers: { authorization: "Bearer owner" },
    })
    expect(second.statusCode).toBe(200)
    expect(second.json().agents).toHaveLength(1)
    expect(second.json().agents[0].agent_id).toBe("agent-b")
    expect(second.json().agents[0].revoked_at).toBeNull()
    expect(second.json().next_cursor).toBeNull()

    const otherOwner = await app.inject({
      method: "GET",
      url: agentsUrl,
      headers: { authorization: "Bearer other" },
    })
    expect(otherOwner.statusCode).toBe(200)
    expect(otherOwner.json().agents).toEqual([])
  } finally {
    await app.close()
  }
})

test("personal memory rejects untrusted owners, missing scopes, anonymous calls, and cross-owner or cross-tenant access", async () => {
  const { app, ownerHeaders, memoriesUrl, agentsUrl, mcp } = await fixture()
  try {
    const created = await app.inject({
      method: "POST",
      url: memoriesUrl,
      headers: ownerHeaders,
      payload: {
        expected_revision: 0,
        idempotency_key: idempotencyKey("owner-memory-isolation"),
        key: "timezone",
        kind: "preference",
        content: "使用 Asia/Taipei。",
      },
    })
    expect(created.statusCode).toBe(201)
    const memoryId = created.json().memory_id as string

    const otherOwner = await app.inject({
      method: "GET",
      url: `${memoriesUrl}/${memoryId}`,
      headers: { authorization: "Bearer other" },
    })
    expect(otherOwner.statusCode).toBe(404)
    expect(otherOwner.body).toContain("MEMORY_NOT_FOUND")

    const otherTenant = await app.inject({
      method: "GET",
      url: `/v1/tenants/${otherTenantId}/me/memories/${memoryId}`,
      headers: { authorization: "Bearer other-tenant" },
    })
    expect(otherTenant.statusCode).toBe(404)
    expect(otherTenant.body).toContain("MEMORY_NOT_FOUND")

    const anotherClient = await mcp("agent-b", initialize())
    expect(anotherClient.statusCode).toBe(403)
    expect(anotherClient.body).toContain("MEMORY_AGENT_GRANT_INVALID")

    const crossTenantMcp = await mcp("other-tenant", initialize(), otherTenantId)
    expect(crossTenantMcp.statusCode).toBe(403)
    expect(crossTenantMcp.body).toContain("MEMORY_AGENT_GRANT_INVALID")

    const wrongClient = await app.inject({
      method: "GET",
      url: memoriesUrl,
      headers: { authorization: "Bearer wrong-client" },
    })
    expect(wrongClient.statusCode).toBe(403)
    expect(wrongClient.body).toContain("MEMORY_SELF_SERVICE_CLIENT_REQUIRED")

    const agentSubject = await app.inject({
      method: "GET",
      url: memoriesUrl,
      headers: { authorization: "Bearer agent-subject" },
    })
    expect(agentSubject.statusCode).toBe(403)
    expect(agentSubject.body).toContain("MEMORY_PERSON_SUBJECT_REQUIRED")

    const missingScope = await app.inject({
      method: "GET",
      url: memoriesUrl,
      headers: { authorization: "Bearer missing-scope" },
    })
    expect(missingScope.statusCode).toBe(403)
    expect(missingScope.body).toContain("INSUFFICIENT_SCOPE")

    const managementOnly = await mcp("management-only", initialize())
    expect(managementOnly.statusCode).toBe(403)
    expect(managementOnly.body).toContain("INSUFFICIENT_SCOPE")

    const anonymous = await mcp("unknown", initialize())
    expect(anonymous.statusCode).toBe(401)
    expect(anonymous.body).toContain("UNAUTHENTICATED")

    const enable = await app.inject({
      method: "POST",
      url: agentsUrl,
      headers: ownerHeaders,
      payload: { agent_id: "agent-a" },
    })
    expect(enable.statusCode).toBe(201)
    const spoofedOwner = await mcp("agent-a", {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "memory_remember",
        arguments: {
          expected_revision: 0,
          idempotency_key: idempotencyKey("spoofed-owner"),
          key: "other-owner",
          kind: "fact",
          content: "不應寫入。",
          owner_subject_id: otherOwnerId,
        },
      },
    })
    expect(spoofedOwner.json().result.isError).toBe(true)
  } finally {
    await app.close()
  }
})
