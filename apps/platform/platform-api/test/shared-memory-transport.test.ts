import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { flushOtel } from "@genioone/telemetry/otlp-observability"

import { createManagementApi } from "../src/app"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"
import type { Principal } from "../src/capabilities/tenancy-auth/contract"

const tenantId = "tenant-shared-memory-transport"

function principal(input: {
  subjectId: string
  clientId: string
  role?: Principal["role"]
  organizationIds?: string[]
  administratorOrganizationIds?: string[]
  scopes?: string[]
}): Principal {
  return {
    tenant_id: tenantId,
    subject_id: input.subjectId,
    client_id: input.clientId,
    role: input.role ?? "USER",
    organization_ids: input.organizationIds ?? [],
    ...(input.administratorOrganizationIds === undefined
      ? {}
      : { administrator_organization_ids: input.administratorOrganizationIds }),
    ...(input.scopes === undefined ? {} : { scopes: input.scopes }),
  }
}

function memoryCommand(input: {
  key: string
  content: string
  expectedRevision?: number
  memoryId?: string
}): Record<string, unknown> {
  return {
    ...(input.memoryId === undefined ? {} : { memory_id: input.memoryId }),
    expected_revision: input.expectedRevision ?? 0,
    idempotency_key: randomUUID(),
    key: input.key,
    kind: "fact",
    context: { kind: "GLOBAL", context_id: null },
    content: input.content,
  }
}

function initialize() {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "shared-memory-transport-test", version: "1" },
    },
  }
}

async function fixture() {
  const modules = createInMemoryPlatformModules({ now: () => 1_000 })
  const admin = principal({
    subjectId: "admin",
    clientId: "genio-one-management-console",
    role: "TENANT_ADMINISTRATOR",
    scopes: ["genioone-invocation"],
  })
  await modules.identity.bootstrap({
    tenantId,
    subjects: [
      { subject_id: "admin", kind: "PERSON", role: "TENANT_ADMINISTRATOR" },
      { subject_id: "maintainer", kind: "PERSON" },
      { subject_id: "contributor", kind: "PERSON" },
      { subject_id: "reader", kind: "PERSON" },
      { subject_id: "service-agent", kind: "AGENT" },
    ],
  })
  const initialOrganization = await modules.organizations.create({
    tenantId,
    display_name: "Shared Memory Transport",
    member_subject_ids: ["maintainer", "contributor", "reader"],
  })
  const organization = await modules.organizations.update({
    tenantId,
    organizationId: initialOrganization.organization_id,
    value: {
      display_name: initialOrganization.display_name,
      member_subject_ids: initialOrganization.member_subject_ids,
      organization_administrator_subject_ids: ["maintainer"],
      membership_sources: initialOrganization.membership_sources,
    },
  })
  for (const [accessGroupId, displayName] of [
    ["readers", "Readers"],
    ["contributors", "Contributors"],
    ["maintainers", "Maintainers"],
  ] as const) {
    await modules.accessGroups.save(admin, accessGroupId, {
      expected_revision: 0,
      organization_id: organization.organization_id,
      display_name: displayName,
      description: "",
      enabled: true,
    })
  }
  await modules.accessGroups.replaceMembers(admin, "readers", {
    expected_group_revision: 1,
    expected_source_revision: 0,
    subject_ids: ["reader"],
  })
  await modules.accessGroups.replaceMembers(admin, "contributors", {
    expected_group_revision: 1,
    expected_source_revision: 0,
    subject_ids: ["contributor"],
  })
  await modules.accessGroups.replaceMembers(admin, "maintainers", {
    expected_group_revision: 1,
    expected_source_revision: 0,
    subject_ids: ["maintainer"],
  })
  const workspace = await modules.distillation.createWorkspace({
    tenantId,
    createdBy: admin.subject_id,
    value: {
      organization_id: organization.organization_id,
      display_name: "Shared Memory Workspace",
      reader_access_group_id: "readers",
      contributor_access_group_id: "contributors",
      maintainer_access_group_id: "maintainers",
    },
  })
  const organizationIds = [organization.organization_id]
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      admin,
      maintainer: principal({
        subjectId: "maintainer",
        clientId: "genio-one-management-console",
        organizationIds,
        administratorOrganizationIds: organizationIds,
        scopes: ["genioone-invocation"],
      }),
      contributor: principal({
        subjectId: "contributor",
        clientId: "genio-one-self-service",
        organizationIds,
        scopes: ["genioone-invocation"],
      }),
      reader: principal({
        subjectId: "reader",
        clientId: "genio-one-self-service",
        organizationIds,
        scopes: ["genioone-invocation"],
      }),
      agent: principal({
        subjectId: "contributor",
        clientId: "agent-a",
        organizationIds,
        scopes: ["genioone-invocation"],
      }),
      "wrong-client": principal({
        subjectId: "maintainer",
        clientId: "untrusted-agent",
        organizationIds,
        scopes: ["genioone-invocation"],
      }),
      "missing-invocation": principal({
        subjectId: "maintainer",
        clientId: "genio-one-management-console",
        organizationIds,
        scopes: ["genioone-management"],
      }),
      "non-person": principal({
        subjectId: "service-agent",
        clientId: "genio-one-self-service",
        organizationIds,
        scopes: ["genioone-invocation"],
      }),
    }),
  })
  const teamMemories = `/v1/tenants/${tenantId}/team-workspaces/${workspace.workspace_id}/memories`
  const organizationMemories = `/v1/tenants/${tenantId}/organizations/${organization.organization_id}/memories`
  const headers = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" })
  const mcp = (body: unknown) => app.inject({
    method: "POST",
    url: `/v1/tenants/${tenantId}/memory/mcp`,
    headers: {
      authorization: "Bearer agent",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    payload: JSON.stringify(body),
  })
  return { app, organization, workspace, teamMemories, organizationMemories, headers, mcp }
}

test("personal, shared and MCP memory payloads stay out of HTTP and module observability", async () => {
  const originalFetch = globalThis.fetch
  const originalOrigin = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://memory-platform-collector.test"
  const exports: any[] = []
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    exports.push(JSON.parse(await new Request(input, init).text()))
    return new Response("{}")
  }, { preconnect: originalFetch.preconnect })
  let f: Awaited<ReturnType<typeof fixture>> | undefined
  try {
    f = await fixture()
    const personalMemories = "/v1/tenants/" + tenantId + "/me/memories"
    const privateValues = ["personal-memory-payload-secret", "team-memory-payload-secret", "organization-memory-payload-secret", "mcp-memory-payload-secret", "failed-memory-payload-secret", "unauthenticated-memory-payload-secret"] as const
    const targets = [
      { url: personalMemories, actor: "contributor", content: privateValues[0] },
      { url: f.teamMemories, actor: "contributor", content: privateValues[1] },
      { url: f.organizationMemories, actor: "maintainer", content: privateValues[2] },
    ]
    let personalMemoryId = ""
    for (const [index, target] of targets.entries()) {
      const created = await f.app.inject({ method: "POST", url: target.url, headers: f.headers(target.actor), payload: memoryCommand({ key: "private-key-" + index, content: target.content }) })
      expect(created.statusCode, created.body).toBe(201)
      expect(created.json().content).toBe(target.content)
      if (index === 0) personalMemoryId = created.json().memory_id
      const listed = await f.app.inject({ method: "GET", url: target.url + "?query=" + encodeURIComponent(target.content), headers: f.headers(target.actor) })
      expect(listed.statusCode, listed.body).toBe(200)
      expect(listed.json().memories[0].content).toBe(target.content)
    }
    const enabled = await f.app.inject({ method: "POST", url: "/v1/tenants/" + tenantId + "/me/memory-agents", headers: f.headers("contributor"), payload: { agent_id: "agent-a" } })
    expect(enabled.statusCode, enabled.body).toBe(201)
    const retrieved = await f.mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_retrieve", arguments: {} } })
    expect(retrieved.statusCode, retrieved.body).toBe(200)
    expect(retrieved.json().result.structuredContent.memories[0].content).toBe(privateValues[0])
    const remembered = await f.mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_remember", arguments: memoryCommand({ key: "mcp-private-key", content: privateValues[3] }) } })
    expect(remembered.statusCode, remembered.body).toBe(200)
    expect(remembered.json().result.structuredContent.content).toBe(privateValues[3])
    const failed = await f.app.inject({
      method: "POST",
      url: personalMemories,
      headers: f.headers("contributor"),
      payload: memoryCommand({ key: "private-key-0", content: privateValues[4], memoryId: personalMemoryId, expectedRevision: 99 }),
    })
    expect(failed.statusCode, failed.body).toBe(409)
    const unauthenticated = await f.app.inject({ method: "POST", url: personalMemories, payload: memoryCommand({ key: "unauthenticated-private-key", content: privateValues[5] }) })
    expect(unauthenticated.statusCode, unauthenticated.body).toBe(401)
    const health = await f.app.inject({ method: "GET", url: "/healthz?query=public-query-evidence" })
    expect(health.statusCode, health.body).toBe(200)
    await f.app.close()
    await flushOtel()
    const serialized = JSON.stringify(exports)
    for (const value of [...privateValues, "public-query-evidence"]) expect(serialized).not.toContain(value)
    const spans = exports.flatMap(value => value.resourceSpans ?? []).flatMap(value => value.scopeSpans).flatMap(value => value.spans)
    const healthSpan = spans.find(value => value.name === "GET /healthz")
    expect(healthSpan).toBeDefined()
    const healthAttributes = Object.fromEntries(healthSpan.attributes.map((value: any) => [value.key, value.value.stringValue ?? value.value.intValue]))
    expect(healthAttributes["genio.request"]).toBe(JSON.stringify({ availability: "OMITTED_HTTP_REQUEST" }))
    expect(healthAttributes["genio.response"]).toBe(JSON.stringify({ availability: "OMITTED_HTTP_RESPONSE" }))
    expect(healthAttributes["http.response.status_code"]).toBe("200")
    const httpSpans = spans.filter(value => value.name.includes(" /v1/tenants/"))
    expect(httpSpans.length).toBeGreaterThanOrEqual(10)
    for (const span of httpSpans) {
      const attributes = Object.fromEntries(span.attributes.map((value: any) => [value.key, value.value.stringValue ?? value.value.intValue]))
      expect(attributes["genio.request"]).toBe(JSON.stringify({ availability: "OMITTED_SENSITIVE_REQUEST" }))
      expect(attributes["genio.response"]).toBe(JSON.stringify({ availability: "OMITTED_SENSITIVE_RESPONSE" }))
      expect(attributes["genio.correlation.id"]).toBeTruthy()
      expect(attributes["http.request.method"]).toBeTruthy()
      expect(attributes["http.response.status_code"]).toBeTruthy()
    }
    const memoryOperations = spans.filter(value => value.name.startsWith("memories."))
    expect(memoryOperations.length).toBeGreaterThanOrEqual(9)
    expect(memoryOperations.some(value => value.status.code === 2)).toBe(true)
    for (const span of memoryOperations) {
      const attributes = Object.fromEntries(span.attributes.map((value: any) => [value.key, value.value.stringValue]))
      expect(attributes["genio.input"]).toBe(JSON.stringify({ availability: "OMITTED_SENSITIVE_OPERATION" }))
      expect(attributes[span.status.code === 2 ? "genio.error" : "genio.output"]).toBe(JSON.stringify({ availability: "OMITTED_SENSITIVE_OPERATION" }))
      expect(attributes["genio.operation"]).toBe(span.name)
      expect(attributes["genio.correlation.id"]).toBeTruthy()
    }
  } finally {
    await f?.app.close()
    globalThis.fetch = originalFetch
    if (originalOrigin === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalOrigin
  }
})

test("shared memory REST keeps direct browser clients scoped, supports manager CAS, and hides proposals from readers", async () => {
  const f = await fixture()
  try {
    const scopes = await f.app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/me/memory-scopes`,
      headers: f.headers("contributor"),
    })
    expect(scopes.statusCode, scopes.body).toBe(200)
    expect(scopes.headers["cache-control"]).toBe("no-store")
    const scopeValues = scopes.json().scopes as Array<{ target: Record<string, string>; can_read: boolean; can_contribute: boolean; can_manage: boolean }>
    expect(scopeValues).toContainEqual(expect.objectContaining({
      target: { scope: "TEAM", workspace_id: f.workspace.workspace_id },
      can_read: true,
      can_contribute: true,
      can_manage: false,
    }))
    expect(scopeValues).toContainEqual(expect.objectContaining({
      target: { scope: "ORGANIZATION", organization_id: f.organization.organization_id },
      can_read: true,
      can_contribute: true,
      can_manage: false,
    }))

    const wrongClient = await f.app.inject({
      method: "GET",
      url: f.teamMemories,
      headers: f.headers("wrong-client"),
    })
    expect(wrongClient.statusCode).toBe(403)
    expect(wrongClient.body).toContain("MEMORY_DIRECT_CLIENT_REQUIRED")

    const missingInvocation = await f.app.inject({
      method: "GET",
      url: f.teamMemories,
      headers: f.headers("missing-invocation"),
    })
    expect(missingInvocation.statusCode).toBe(403)
    expect(missingInvocation.body).toContain("INSUFFICIENT_SCOPE")

    const nonPerson = await f.app.inject({
      method: "GET",
      url: f.teamMemories,
      headers: f.headers("non-person"),
    })
    expect(nonPerson.statusCode).toBe(403)
    expect(nonPerson.body).toContain("MEMORY_PERSON_SUBJECT_REQUIRED")

    const invalidCommand = await f.app.inject({
      method: "POST",
      url: f.teamMemories,
      headers: f.headers("maintainer"),
      payload: { ...memoryCommand({ key: "invalid-shared-command", content: "This must not persist." }), unexpected: true },
    })
    expect(invalidCommand.statusCode).toBe(400)
    expect(invalidCommand.body).toContain("REQUEST_VALIDATION_FAILED")

    const created = await f.app.inject({
      method: "POST",
      url: f.teamMemories,
      headers: f.headers("maintainer"),
      payload: memoryCommand({ key: "release-window", content: "Team deploys on Tuesday." }),
    })
    expect(created.statusCode, created.body).toBe(201)
    const memory = created.json() as { memory_id: string; revision: number; content: string }
    expect(created.headers["cache-control"]).toBe("no-store")

    const listedByContributor = await f.app.inject({
      method: "GET",
      url: f.teamMemories,
      headers: f.headers("contributor"),
    })
    expect(listedByContributor.statusCode).toBe(200)
    expect(listedByContributor.json().memories).toHaveLength(1)

    const managerCas = await f.app.inject({
      method: "POST",
      url: f.teamMemories,
      headers: f.headers("maintainer"),
      payload: memoryCommand({
        memoryId: memory.memory_id,
        expectedRevision: memory.revision,
        key: "release-window",
        content: "Team deploys after the manager review.",
      }),
    })
    expect(managerCas.statusCode, managerCas.body).toBe(200)
    const managedMemory = managerCas.json() as { memory_id: string; revision: number; content: string }
    expect(managedMemory.memory_id).toBe(memory.memory_id)
    expect(managedMemory.content).toBe("Team deploys after the manager review.")

    const contributorCas = await f.app.inject({
      method: "POST",
      url: f.teamMemories,
      headers: f.headers("contributor"),
      payload: memoryCommand({
        memoryId: memory.memory_id,
        expectedRevision: managedMemory.revision,
        key: "release-window",
        content: "Contributor cannot replace the managed memory.",
      }),
    })
    expect(contributorCas.statusCode).toBe(403)
    expect(contributorCas.body).toContain("SHARED_MEMORY_SCOPE_ACCESS_REQUIRED")

    const proposal = await f.app.inject({
      method: "POST",
      url: `${f.teamMemories}/${memory.memory_id}/corrections`,
      headers: f.headers("contributor"),
      payload: {
        expected_revision: managedMemory.revision,
        idempotency_key: randomUUID(),
        content: "Team deploys after the contributor review.",
      },
    })
    expect(proposal.statusCode, proposal.body).toBe(201)
    const proposalValue = proposal.json() as { proposal_id: string; status: string; proposed_content: string }
    expect(proposalValue.status).toBe("PENDING")

    const hiddenFromContributor = await f.app.inject({
      method: "GET",
      url: `${f.teamMemories}/${memory.memory_id}/corrections`,
      headers: f.headers("contributor"),
    })
    expect(hiddenFromContributor.statusCode).toBe(403)
    expect(hiddenFromContributor.body).not.toContain(proposalValue.proposed_content)

    const hiddenFromReader = await f.app.inject({
      method: "GET",
      url: `${f.teamMemories}/${memory.memory_id}/corrections`,
      headers: f.headers("reader"),
    })
    expect(hiddenFromReader.statusCode).toBe(403)
    expect(hiddenFromReader.body).not.toContain(proposalValue.proposed_content)

    const managerProposals = await f.app.inject({
      method: "GET",
      url: `${f.teamMemories}/${memory.memory_id}/corrections?status=PENDING`,
      headers: f.headers("maintainer"),
    })
    expect(managerProposals.statusCode, managerProposals.body).toBe(200)
    expect(managerProposals.json().proposals).toHaveLength(1)

    const reviewed = await f.app.inject({
      method: "POST",
      url: `${f.teamMemories}/${memory.memory_id}/corrections/${proposalValue.proposal_id}/review`,
      headers: f.headers("maintainer"),
      payload: { action: "ACCEPT" },
    })
    expect(reviewed.statusCode, reviewed.body).toBe(200)
    expect(reviewed.json().proposal.status).toBe("ACCEPTED")
    expect(reviewed.json().proposal.proposed_content).toBeNull()
    expect(reviewed.json().memory.content).toBe("Team deploys after the contributor review.")

    const contributorDelete = await f.app.inject({
      method: "DELETE",
      url: `${f.teamMemories}/${memory.memory_id}`,
      headers: f.headers("contributor"),
      payload: { expected_revision: managedMemory.revision + 1, idempotency_key: randomUUID() },
    })
    expect(contributorDelete.statusCode).toBe(403)

    const removed = await f.app.inject({
      method: "DELETE",
      url: `${f.teamMemories}/${memory.memory_id}`,
      headers: f.headers("maintainer"),
      payload: { expected_revision: managedMemory.revision + 1, idempotency_key: randomUUID() },
    })
    expect(removed.statusCode, removed.body).toBe(200)

    const noPutRoute = await f.app.inject({
      method: "PUT",
      url: `${f.teamMemories}/${memory.memory_id}`,
      headers: f.headers("maintainer"),
      payload: memoryCommand({
        memoryId: memory.memory_id,
        expectedRevision: managedMemory.revision + 1,
        key: "release-window",
        content: "No PUT route.",
      }),
    })
    expect(noPutRoute.statusCode).toBe(404)

    const organizationCreated = await f.app.inject({
      method: "POST",
      url: f.organizationMemories,
      headers: f.headers("maintainer"),
      payload: memoryCommand({ key: "organization-language", content: "Use Taiwan Traditional Chinese." }),
    })
    expect(organizationCreated.statusCode, organizationCreated.body).toBe(201)
    const organizationRead = await f.app.inject({
      method: "GET",
      url: `${f.organizationMemories}/${organizationCreated.json().memory_id}`,
      headers: f.headers("contributor"),
    })
    expect(organizationRead.statusCode).toBe(200)
  } finally {
    await f.app.close()
  }
})

test("shared memory MCP keeps personal defaults and adds strict targets, scope discovery, and proposal results", async () => {
  const f = await fixture()
  try {
    const enabled = await f.app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/me/memory-agents`,
      headers: f.headers("contributor"),
      payload: { agent_id: "agent-a" },
    })
    expect(enabled.statusCode, enabled.body).toBe(201)

    const created = await f.app.inject({
      method: "POST",
      url: f.teamMemories,
      headers: f.headers("maintainer"),
      payload: memoryCommand({ key: "agent-correction", content: "The original shared fact." }),
    })
    expect(created.statusCode).toBe(201)
    const memory = created.json() as { memory_id: string; revision: number }

    const initialized = await f.mcp(initialize())
    expect(initialized.statusCode).toBe(200)

    const tools = await f.mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    expect(tools.statusCode).toBe(200)
    expect(tools.json().result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "memory_list",
      "memory_retrieve",
      "memory_get",
      "memory_remember",
      "memory_forget",
      "memory_scope_list",
    ])

    const scopes = await f.mcp({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "memory_scope_list", arguments: {} },
    })
    expect(scopes.statusCode).toBe(200)
    expect(scopes.json().result.structuredContent.scopes).toContainEqual({
      scope: "TEAM",
      workspace_id: f.workspace.workspace_id,
    })
    expect(scopes.json().result.structuredContent.scopes).toContainEqual({ scope: "PERSONAL" })
    expect(scopes.json().result.structuredContent.scopes).toContainEqual({
      scope: "ORGANIZATION",
      organization_id: f.organization.organization_id,
    })

    const missingContext = await f.mcp({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "memory_remember",
        arguments: {
          expected_revision: 0,
          idempotency_key: randomUUID(),
          key: "agent-context-required",
          kind: "fact",
          content: "Shared Agent writes need an explicit context.",
          target: { scope: "TEAM", workspace_id: f.workspace.workspace_id },
        },
      },
    })
    expect(missingContext.statusCode).toBe(200)
    expect(missingContext.body).toContain("MEMORY_CONTEXT_REQUIRED")

    const proposed = await f.mcp({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "memory_remember",
        arguments: {
          memory_id: memory.memory_id,
          expected_revision: memory.revision,
          idempotency_key: randomUUID(),
          key: "agent-correction",
          kind: "fact",
          context: { kind: "GLOBAL", context_id: null },
          content: "The contributor agent proposed a correction.",
          target: { scope: "TEAM", workspace_id: f.workspace.workspace_id },
        },
      },
    })
    expect(proposed.statusCode, proposed.body).toBe(200)
    expect(proposed.json().result.structuredContent.result).toBe("PROPOSAL")
    expect(proposed.json().result.structuredContent.proposal.memory_id).toBe(memory.memory_id)

    const listed = await f.mcp({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "memory_list",
        arguments: { target: { scope: "TEAM", workspace_id: f.workspace.workspace_id } },
      },
    })
    expect(listed.statusCode).toBe(200)
    expect(listed.json().result.structuredContent.memories).toEqual(expect.arrayContaining([
      expect.objectContaining({ memory_id: memory.memory_id, scope: "TEAM" }),
    ]))

    const got = await f.mcp({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "memory_get",
        arguments: {
          memory_id: memory.memory_id,
          target: { scope: "TEAM", workspace_id: f.workspace.workspace_id },
        },
      },
    })
    expect(got.statusCode).toBe(200)
    expect(got.json().result.structuredContent.memory_id).toBe(memory.memory_id)

    const forbiddenForget = await f.mcp({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "memory_forget",
        arguments: {
          memory_id: memory.memory_id,
          expected_revision: memory.revision,
          idempotency_key: randomUUID(),
          target: { scope: "TEAM", workspace_id: f.workspace.workspace_id },
        },
      },
    })
    expect(forbiddenForget.statusCode).toBe(200)
    expect(forbiddenForget.body).toContain("SHARED_MEMORY_SCOPE_ACCESS_REQUIRED")

    const retrieved = await f.mcp({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "memory_retrieve",
        arguments: {
          query: "original shared",
          targets: [
            { scope: "PERSONAL" },
            { scope: "TEAM", workspace_id: f.workspace.workspace_id },
          ],
        },
      },
    })
    expect(retrieved.statusCode).toBe(200)
    expect(retrieved.json().result.structuredContent.memories).toEqual(expect.arrayContaining([
      expect.objectContaining({ memory_id: memory.memory_id, scope: "TEAM" }),
    ]))

    const duplicateTargets = await f.mcp({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "memory_retrieve",
        arguments: {
          targets: [
            { scope: "TEAM", workspace_id: f.workspace.workspace_id },
            { scope: "TEAM", workspace_id: f.workspace.workspace_id },
          ],
        },
      },
    })
    expect(duplicateTargets.statusCode).toBe(200)
    expect(duplicateTargets.body).toContain("MEMORY_TARGET_DUPLICATE")

    const emptyTargets = await f.mcp({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "memory_retrieve", arguments: { targets: [] } },
    })
    expect(emptyTargets.statusCode).toBe(200)
    expect(emptyTargets.json().error ?? emptyTargets.json().result?.isError).toBeTruthy()

    const tooManyTargets = await f.mcp({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: {
        name: "memory_retrieve",
        arguments: {
          targets: Array.from({ length: 21 }, (_, index) => ({
            scope: "ORGANIZATION",
            organization_id: `organization-${index}`,
          })),
        },
      },
    })
    expect(tooManyTargets.statusCode).toBe(200)
    expect(tooManyTargets.json().error ?? tooManyTargets.json().result?.isError).toBeTruthy()

    const unknownTargetField = await f.mcp({
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: {
        name: "memory_get",
        arguments: {
          memory_id: memory.memory_id,
          target: { scope: "TEAM", workspace_id: f.workspace.workspace_id, organization_id: f.organization.organization_id },
        },
      },
    })
    expect(unknownTargetField.statusCode).toBe(200)
    expect(unknownTargetField.json().error ?? unknownTargetField.json().result?.isError).toBeTruthy()
  } finally {
    await f.app.close()
  }
})
