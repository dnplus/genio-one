import assert from "node:assert/strict"
import test from "node:test"

import { DISTILLATION_EXTRACTOR_VERSION } from "@genioone/protocol/distillation-triage"

import { createBotApp } from "../../../bot/server/app"
import { BotRegistry } from "../../../bot/server/bot-registry"
import { markerContentDigest } from "../../../bot/server/distillation/history"
import type { Turn } from "../../../bot/server/generated/v2/Turn"
import { createManagementApi } from "../src/app"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import type { Principal } from "../src/capabilities/tenancy-auth/contract"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"

const tenantId = "tenant-evidence-integration"

function principal(subjectId: string, scopes: string[]): Principal {
  return {
    tenant_id: tenantId,
    subject_id: subjectId,
    client_id: "management-ui",
    role: "USER",
    organization_ids: [],
    scopes,
  }
}

function turn(turnId: string, userText: string, assistantText: string): Turn {
  return {
    id: turnId,
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    items: [
      { type: "userMessage", id: `${turnId}-user`, content: [{ type: "text", text: userText }] },
      { type: "agentMessage", id: `${turnId}-assistant`, text: assistantText },
      {
        type: "mcpToolCall",
        id: `${turnId}-tool`,
        server: "private-service",
        tool: "read-secret",
        status: "completed",
        arguments: { value: "tool-input-secret" },
        appContext: null,
        mcpAppResourceUri: undefined,
        pluginId: null,
        readOnlyHint: true,
        result: { content: [{ type: "text", text: "tool-output-secret" }] },
        error: null,
        durationMs: 1,
      },
    ],
  } as unknown as Turn
}

test("Platform and Bot preserve live evidence authorization through review", async () => {
  const modules = createInMemoryPlatformModules({ now: () => 1_000 })
  const registry = new BotRegistry(":memory:")
  const owner = principal("owner", ["genioone-management", "genioone-invocation"])
  const maintainer = principal("maintainer", ["genioone-management"])
  const reader = principal("reader", ["genioone-management"])
  const admin: Principal = {
    tenant_id: tenantId,
    subject_id: "admin",
    client_id: "management-ui",
    role: "TENANT_ADMINISTRATOR",
    organization_ids: [],
    scopes: ["genioone-management"],
  }
  const bot = registry.create({
    tenant_id: tenantId,
    subject_id: owner.subject_id,
    acting_client_id: "genio-one-bot",
    scopes: ["genioone-management", "genioone-invocation"],
  }, { name: "Evidence Bot", description: "Evidence source" })
  const successAssistant = `助手可見答案 ${"a".repeat(120_000)}`
  registry.rememberThread(bot.id, "thread-success")
  registry.timeline.putTurn(bot.id, "thread-success", turn("turn-success", "使用者可見請求", successAssistant))
  registry.rememberThread(bot.id, "thread-changed")
  registry.timeline.putTurn(bot.id, "thread-changed", turn("turn-changed", "原始請求", "原始答案"))
  const botApp = await createBotApp({ botRegistry: registry })
  let platform: Awaited<ReturnType<typeof createManagementApi>> | null = null
  const previousOrigin = process.env.GENIO_ONE_PLATFORM_ORIGIN
  const originalFetch = globalThis.fetch
  const platformOrigin = "http://platform.integration.test"
  let botBridgeCalls = 0
  let reviewContextCalls = 0
  try {
    platform = await createManagementApi({
      modules,
      resourceCatalog: modules.resources,
      browserIdentity: {
        tenant_id: tenantId,
        issuer: "https://identity.example",
        authorization_endpoint: "https://identity.example/auth",
        token_endpoint: "https://identity.example/token",
        client_id: "management-ui",
        scopes: ["genioone-management", "genioone-invocation"],
        management_client_id: "management-ui",
        management_scopes: ["genioone-management"],
      },
      botServiceEndpoint: "http://bot.integration.test",
      botFetch: async (input, init) => {
        botBridgeCalls += 1
        const url = new URL(String(input))
        const response = await botApp.inject({
          method: "GET",
          url: `${url.pathname}${url.search}`,
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
        })
        return new Response(response.body, {
          status: response.statusCode,
          headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, String(value)])),
        })
      },
      principalAuthenticator: createStaticPrincipalAuthenticator({
        admin,
        "owner-token": owner,
        "maintainer-token": maintainer,
        "reader-token": reader,
      }),
    })
    platform.addHook("onRequest", async (request) => {
      if (request.url.includes("/review-context")) reviewContextCalls += 1
    })
    process.env.GENIO_ONE_PLATFORM_ORIGIN = platformOrigin
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input))
      if (url.origin !== platformOrigin) return originalFetch(input, init)
      const response = await platform!.inject({
        method: "GET",
        url: `${url.pathname}${url.search}`,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      })
      return new Response(response.body, {
        status: response.statusCode,
        headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, String(value)])),
      })
    }) as typeof fetch
    await modules.identity.bootstrap({
      tenantId,
      subjects: [
        { subject_id: "admin", kind: "PERSON", role: "TENANT_ADMINISTRATOR" },
        { subject_id: "owner", kind: "PERSON" },
        { subject_id: "maintainer", kind: "PERSON" },
        { subject_id: "reader", kind: "PERSON" },
      ],
    })
    const organization = await modules.organizations.create({ tenantId, display_name: "Evidence" })
    for (const [accessGroupId, displayName] of [
      ["readers", "Readers"],
      ["contributors", "Contributors"],
      ["maintainers", "Maintainers"],
    ] as const) {
      await modules.accessGroups.save(admin, accessGroupId, {
        expected_revision: 0,
        display_name: displayName,
        description: "",
        enabled: true,
      })
    }
    await modules.accessGroups.replaceMembers(admin, "readers", {
      expected_group_revision: 1,
      expected_source_revision: 0,
      subject_ids: [reader.subject_id],
    })
    await modules.accessGroups.replaceMembers(admin, "contributors", {
      expected_group_revision: 1,
      expected_source_revision: 0,
      subject_ids: [owner.subject_id],
    })
    await modules.accessGroups.replaceMembers(admin, "maintainers", {
      expected_group_revision: 1,
      expected_source_revision: 0,
      subject_ids: [maintainer.subject_id],
    })
    const workspace = await platform.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/team-workspaces`,
      headers: { authorization: "Bearer admin" },
      payload: {
        organization_id: organization.organization_id,
        display_name: "Evidence workspace",
        reader_access_group_id: "readers",
        contributor_access_group_id: "contributors",
        maintainer_access_group_id: "maintainers",
      },
    })
    assert.equal(workspace.statusCode, 200)
    const workspaceId = (workspace.json() as { workspace_id: string }).workspace_id

    const completeCandidate = async (threadId: string, turnId: string) => {
      const stored = registry.timeline.storedTurn(bot.id, threadId, turnId)
      assert.ok(stored)
      const digest = markerContentDigest([stored.bodyJson])
      const marker = await platform!.inject({
        method: "POST",
        url: `/v1/tenants/${tenantId}/distillation-markers`,
        headers: { authorization: "Bearer owner-token" },
        payload: {
          bot_id: bot.id,
          thread_id: threadId,
          turn_ids: [turnId],
          source_revision: "a".repeat(64),
          content_digest: digest,
          scope_hint: "process",
          sensitivity: "standard",
          knowledge_type: "PROCEDURE",
          representation: "BOTH",
          classifier_version: "jev-distillation-1",
          extractor_version: DISTILLATION_EXTRACTOR_VERSION,
          evidence: [],
          excerpt_truncated: false,
          workspace_id: workspaceId,
        },
      })
      assert.equal(marker.statusCode, 200)
      const markerId = (marker.json() as { marker_id: string }).marker_id
      const claim = await platform!.inject({
        method: "POST",
        url: `/v1/tenants/${tenantId}/distillation-markers/claim`,
        headers: { authorization: "Bearer owner-token" },
        payload: { bot_id: bot.id, lease_owner: "integration-worker" },
      })
      assert.equal(claim.statusCode, 200)
      const complete = await platform!.inject({
        method: "POST",
        url: `/v1/tenants/${tenantId}/distillation-markers/${markerId}/result`,
        headers: { authorization: "Bearer owner-token" },
        payload: {
          lease_token: (claim.json() as { lease_token: string }).lease_token,
          outcome: "CANDIDATE_CREATED",
          content_digest: digest,
        },
      })
      assert.equal(complete.statusCode, 200)
      return (complete.json() as { candidate: { knowledge_id: string } }).candidate.knowledge_id
    }

    const successKnowledgeId = await completeCandidate("thread-success", "turn-success")
    const storedCandidate = await modules.distillation.getCandidate({ tenantId, knowledgeId: successKnowledgeId })
    assert.ok(storedCandidate)
    assert.doesNotMatch(JSON.stringify(storedCandidate), /使用者可見請求|助手可見答案|tool-input-secret|tool-output-secret/)

    const denied = await platform.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/knowledge-candidates/${successKnowledgeId}/evidence`,
      headers: { authorization: "Bearer reader-token" },
    })
    assert.equal(denied.statusCode, 403)
    assert.equal(botBridgeCalls, 0)

    const evidence = await platform.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/knowledge-candidates/${successKnowledgeId}/evidence`,
      headers: { authorization: "Bearer maintainer-token" },
    })
    assert.equal(evidence.statusCode, 200)
    assert.equal(evidence.headers["cache-control"], "no-store")
    const evidenceTurn = (evidence.json() as { turns: Array<{ text: string; truncated: boolean }> }).turns[0]!
    assert.equal(evidenceTurn.truncated, true)
    assert.match(evidenceTurn.text, /使用者可見請求/)
    assert.match(evidenceTurn.text, /助手可見答案/)
    assert.ok(evidenceTurn.text.length > 65_536)
    assert.ok(evidenceTurn.text.length < "使用者可見請求\n".length + successAssistant.length)
    assert.doesNotMatch(evidence.body, /tool-input-secret|tool-output-secret/)

    const approved = await platform.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/knowledge-candidates/${successKnowledgeId}/review`,
      headers: { authorization: "Bearer maintainer-token" },
      payload: { decision: "APPROVE" },
    })
    assert.equal(approved.statusCode, 200)
    assert.equal((approved.json() as { review_state: string }).review_state, "APPROVED")
    assert.equal((approved.json() as { reviewed_by: string }).reviewed_by, maintainer.subject_id)
    assert.ok(botBridgeCalls >= 2)
    assert.ok(reviewContextCalls >= 2)

    const changedKnowledgeId = await completeCandidate("thread-changed", "turn-changed")
    registry.timeline.putTurn(bot.id, "thread-changed", turn("turn-changed", "變更後請求", "變更後答案"))
    const changed = await platform.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/knowledge-candidates/${changedKnowledgeId}/review`,
      headers: { authorization: "Bearer maintainer-token" },
      payload: { decision: "APPROVE" },
    })
    assert.equal(changed.statusCode, 409)
    assert.equal((changed.json() as { code: string }).code, "KNOWLEDGE_EVIDENCE_CHANGED")
    assert.equal((await modules.distillation.getCandidate({ tenantId, knowledgeId: changedKnowledgeId }))?.review_state, "PENDING_REVIEW")
  } finally {
    globalThis.fetch = originalFetch
    if (previousOrigin === undefined) delete process.env.GENIO_ONE_PLATFORM_ORIGIN
    else process.env.GENIO_ONE_PLATFORM_ORIGIN = previousOrigin
    await platform?.close()
    await botApp.close()
    registry.close()
  }
})
