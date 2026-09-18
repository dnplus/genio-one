import { afterEach, describe, expect, test } from "bun:test"

import { BotRegistry, toBotProfile } from "./bot-registry"
import type { GenioPrincipal } from "./runtime-broker"

const owner: GenioPrincipal = {
  tenant_id: "tenant-keycloak-local",
  subject_id: "person-owner",
  acting_client_id: "genio-one-bot",
  scopes: ["genioone-invocation"],
}

const caller: GenioPrincipal = { ...owner, subject_id: "person-caller" }

describe("BotRegistry", () => {
  let registry: BotRegistry | null = null

  afterEach(() => registry?.close())

  test("persists profiles, bindings, sessions, and duplicate isolation in the server store", () => {
    registry = new BotRegistry(":memory:")
    const first = registry.create(owner, {
      name: "Ops",
      role: "營運夥伴",
      title: "Ops desk",
      description: "處理營運案件",
      skills: ["servicenow-csm"],
      bindings: [{ resourceId: "servicenow-csm", capabilityId: "servicenow.csm.read_case", version: "1.0.0", kind: "MCP" }],
    })
    registry.saveSession({ botId: first.id, appServerThreadId: "thread-1", activeRuntimeTier: "none" })
    const copy = registry.duplicate(first.id, owner)

    expect(registry.list(owner).map((bot) => bot.name)).toEqual(["Ops", "Ops 副本"])
    expect(registry.getSession(first.id)?.appServerThreadId).toBe("thread-1")
    expect(copy.bindings).toHaveLength(1)
    expect(copy.id).not.toBe(first.id)
  })

  test("requires explicit sharing before another principal can invoke a bot", () => {
    registry = new BotRegistry(":memory:")
    const store = registry
    const target = store.create(owner, { name: "Shared", role: "案件專家", bindings: [{ resourceId: "servicenow-csm", capabilityId: "servicenow.csm.read_case", kind: "MCP" }] })
    expect(store.list(caller)).toEqual([])
    expect(() => store.createInvocation(caller, {
      callerBotId: target.id,
      targetBotId: target.id,
      task: "查詢 CS001284",
      actionDigest: "digest-1",
    })).toThrow("BOT_NOT_FOUND")

    store.update(target.id, owner, {
      sharePolicy: { visibility: "ORG", discoverable: true, invocable: true, approval: "ALWAYS_ASK", audienceIds: [] },
    })
    const callerBot = store.create(caller, { name: "Caller", role: "協調者" })
    const request = store.createInvocation(caller, {
      callerBotId: callerBot.id,
      targetBotId: target.id,
      task: "查詢 CS001284",
      selectedContextRefs: ["current-task"],
      requestedCapabilityIds: ["servicenow.csm.read_case"],
      actionDigest: "digest-1",
    })
    expect(request.state).toBe("PENDING")
    const approved = store.decideInvocation(owner, request.requestId, "APPROVE", "可執行")
    expect(approved.state).toBe("APPROVED")
    expect(store.beginInvocation(request.requestId)?.state).toBe("RUNNING")
    expect(store.beginInvocation(request.requestId)).toBeNull()
  })

  test("installation is idempotent for the same package revision", () => {
    registry = new BotRegistry(":memory:")
    registry.registerPackage({ packageType: "BOT", resourceId: "test-package", version: "1.0.0", profile: { title: "Test", description: "Test package", avatar: {} }, skills: [], plugins: [], resourceBindings: [], defaultRuntimeTier: "none", manifestDigest: "test-manifest", artifactDigest: "test-artifact", source: { kind: "UPLOAD", ref: "test-upload" } })
    expect(() => registry!.install(owner, "test-package", "1.0.0")).toThrow("BOT_PACKAGE_ARTIFACT_NOT_FOUND")
    expect(registry.list(owner)).toEqual([])
  })

  test("expires a pending request before an owner can approve it", () => {
    registry = new BotRegistry(":memory:")
    const target = registry.create(owner, { name: "Expiring", role: "案件專家" })
    registry.update(target.id, owner, { sharePolicy: { visibility: "ORG", discoverable: true, invocable: true } })
    const callerBot = registry.create(caller, { name: "Caller", role: "協調者" })
    const request = registry.createInvocation(caller, {
      callerBotId: callerBot.id,
      targetBotId: target.id,
      task: "查詢 CS001284",
      actionDigest: "digest-expiring",
      expiresAt: Date.now() - 1,
    })
    const expired = registry.decideInvocation(owner, request.requestId, "APPROVE")
    expect(expired.state).toBe("EXPIRED")
  })

  test("does not approve or start a request after sharing is revoked", () => {
    registry = new BotRegistry(":memory:")
    const target = registry.create(owner, {
      name: "Revoked",
      role: "案件專家",
      bindings: [{ resourceId: "servicenow-csm", capabilityId: "servicenow.csm.read_case", kind: "MCP" }],
    })
    registry.update(target.id, owner, { sharePolicy: { visibility: "ORG", discoverable: true, invocable: true } })
    const callerBot = registry.create(caller, { name: "Caller", role: "協調者" })
    const request = registry.createInvocation(caller, {
      callerBotId: callerBot.id,
      targetBotId: target.id,
      task: "查詢 CS001284",
      requestedCapabilityIds: ["servicenow.csm.read_case"],
      actionDigest: "digest-revoked",
    })
    registry.update(target.id, owner, { sharePolicy: { visibility: "PRIVATE", discoverable: false, invocable: false } })
    const denied = registry.decideInvocation(owner, request.requestId, "APPROVE")
    expect(denied.state).toBe("DENIED")
    expect(registry.beginInvocation(request.requestId)?.state).toBe("DENIED")
  })

  test("same-owner private Bot can still begin a handoff invocation", () => {
    registry = new BotRegistry(":memory:")
    const callerBot = registry.create(owner, { name: "Policy Bot", role: "協調者" })
    const target = registry.create(owner, {
      name: "Nova",
      role: "助手",
    })
    registry.update(target.id, owner, { sharePolicy: { visibility: "PRIVATE", discoverable: false, invocable: false } })
    const ack = registry.createHandoff(owner, {
      fromBotId: callerBot.id,
      toBotId: target.id,
      fact: "查個新聞給我",
      kind: "task",
    })
    expect(ack.invocationId).toBeTruthy()
    const started = registry.beginInvocation(ack.invocationId)
    expect(started?.state).toBe("RUNNING")
  })

  test("slice A: create + getProfile keeps title/description/modelRoute/owner separate from role dump", () => {
    registry = new BotRegistry(":memory:")
    const created = registry.create(owner, {
      name: "蛋博士",
      title: "產品設計顧問",
      description: "幫我把模糊需求收斂成可交付規格；不要擅自對外寄信。",
      avatar: { shape: "cercle", color: "turquoise", expression: "attentif" },
      modelRoute: "codex-subscription",
    })
    const profile = registry.getProfile(created.id, owner)
    expect(profile).not.toBeNull()
    expect(profile!.botId).toBe(created.id)
    expect(profile!.name).toBe("蛋博士")
    expect(profile!.title).toBe("產品設計顧問")
    expect(profile!.description).toBe("幫我把模糊需求收斂成可交付規格；不要擅自對外寄信。")
    expect(profile!.title).not.toBe(profile!.description)
    expect(profile!.modelRoute).toBe("codex-subscription")
    expect(profile!.tenantId).toBe(owner.tenant_id)
    expect(profile!.ownerSubjectId).toBe(owner.subject_id)
    expect(profile!.createdAt).toBeGreaterThan(0)
    expect(profile!.updatedAt).toBeGreaterThan(0)
    expect(created.role).toBe(created.description)
    expect(toBotProfile(created)).toEqual(profile!)
  })

  test("persists the owner organization and canonical use case alongside the agent binding", () => {
    registry = new BotRegistry(":memory:")
    const created = registry.create(owner, {
      name: "Engineering Agent",
      ownerOrganizationId: "org-engineering",
      useCaseId: "uat-purpose-dylan",
      agentSubjectId: "agent-dylan",
    })
    expect(created.ownerSubjectId).toBe(owner.subject_id)
    expect(created.agentSubjectId).toBe("agent-dylan")
    expect(created.ownerOrganizationId).toBe("org-engineering")
    expect(created.useCaseId).toBe("uat-purpose-dylan")
    expect(registry.getProfile(created.id, owner)).toMatchObject({
      ownerOrganizationId: "org-engineering",
      useCaseId: "uat-purpose-dylan",
    })
  })

  test("does not carry a stale usage context into a different owner organization", () => {
    registry = new BotRegistry(":memory:")
    const engineeringOwner: GenioPrincipal = { ...owner, organization_ids: ["org-engineering"] }
    const salesOwner: GenioPrincipal = { ...owner, organization_ids: ["org-sales"] }
    const source = registry.create(engineeringOwner, {
      name: "Engineering Agent",
      ownerOrganizationId: "org-engineering",
      useCaseId: "uat-purpose-dylan",
    })

    const sameOwnerCopy = registry.duplicate(source.id, engineeringOwner)
    expect(sameOwnerCopy.ownerOrganizationId).toBe("org-engineering")
    expect(sameOwnerCopy.useCaseId).toBe("uat-purpose-dylan")

    const crossOrganizationCopy = registry.duplicate(source.id, salesOwner)
    expect(crossOrganizationCopy.ownerSubjectId).toBe(salesOwner.subject_id)
    expect(crossOrganizationCopy.ownerOrganizationId).toBeNull()
    expect(crossOrganizationCopy.useCaseId).toBeNull()
  })

  test("keeps cross-tier artifacts as explicit server-owned references", () => {
    registry = new BotRegistry(":memory:")
    const bot = registry.create(owner, { name: "Slides", role: "簡報助手" })
    const artifact = registry.registerArtifact(owner, {
      botId: bot.id,
      sourceTier: "headless",
      sourceEnvironmentId: "e2b-headless-1",
      path: "/home/user/presentation.html",
      digest: "sha256:presentation",
      contentType: "text/html",
      size: 128,
    })
    expect(registry.listArtifacts(owner, bot.id)).toEqual([artifact])
    expect(registry.getArtifact(owner, bot.id, artifact.artifactId)?.sourceTier).toBe("headless")
    registry.storeArtifactBytes(artifact.artifactId, new TextEncoder().encode("<h1>GenioOne</h1>"))
    expect(new TextDecoder().decode(registry.readArtifactBytes(artifact.artifactId))).toBe("<h1>GenioOne</h1>")
  })

  test("slice B: BotSession persists thread pointer and projects unread/working across reopen", () => {
    registry = new BotRegistry(":memory:")
    const bot = registry.create(owner, {
      name: "Aqua",
      title: "切片 B",
      description: "server-side BotSession projection",
    })
    registry.saveSession({ botId: bot.id, appServerThreadId: "thread-aqua-1", activeRuntimeTier: "none", memoryPointer: "mem-1" })
    registry.saveSession({ botId: bot.id, appServerThreadId: "thread-aqua-2" })
    registry.saveSession({ botId: bot.id, appServerThreadId: "thread-aqua-1" })
    expect(registry.getSessionThreads(bot.id).map((entry) => entry.threadId)).toEqual(["thread-aqua-1", "thread-aqua-2"])
    registry.applySessionEvent(bot.id, "turn_started")
    expect(registry.getSession(bot.id)?.workState).toBe("working")
    expect(registry.getSession(bot.id)?.unread).toBe(false)

    registry.applySessionEvent(bot.id, "turn_completed")
    let session = registry.getSession(bot.id)!
    expect(session.workState).toBe("idle")
    expect(session.unread).toBe(true)
    expect(session.appServerThreadId).toBe("thread-aqua-1")
    expect(session.memoryPointer).toBe("mem-1")

    registry.applySessionEvent(bot.id, "viewed")
    expect(registry.getSession(bot.id)?.unread).toBe(false)

    const other = registry.create(owner, { name: "Darkness", title: "另一隻", description: "切換不丟 session" })
    registry.saveSession({ botId: other.id, appServerThreadId: "thread-dark-1", activeRuntimeTier: "headless" })
    // switching focus is client-side; server keeps both sessions
    expect(registry.getSession(bot.id)?.appServerThreadId).toBe("thread-aqua-1")
    expect(registry.getSession(other.id)?.appServerThreadId).toBe("thread-dark-1")

    const roster = registry.listRoster(owner)
    expect(roster).toHaveLength(2)
    expect(roster.map((entry) => entry.bot.id).sort()).toEqual([bot.id, other.id].sort())
    expect(roster.find((entry) => entry.bot.id === bot.id)?.session.unread).toBe(false)
    expect(roster.find((entry) => entry.bot.id === other.id)?.session.appServerThreadId).toBe("thread-dark-1")
  })


  test("slice D: designer fields persist; create defaults to zero skills/bindings/private", () => {
    registry = new BotRegistry(":memory:")
    const created = registry.create(owner, {
      name: "阿庫婭",
      title: "切片收斂",
      description: "## One job\n切片收斂\n\n## Anti-jobs\nx\n\n## Voice\ny\n\n## Wake\nz",
      antiJobs: "不安裝插件",
      voice: "直球",
      wake: "chat",
    })
    expect(created.skills).toEqual([])
    expect(created.bindings).toEqual([])
    expect(created.sharePolicy.visibility).toBe("PRIVATE")
    const profile = registry.getProfile(created.id, owner)!
    expect(profile.antiJobs).toBe("不安裝插件")
    expect(profile.voice).toBe("直球")
    expect(profile.wake).toBe("chat")
    expect(profile.visibility).toBe("PRIVATE")
    expect(profile.title).toBe("切片收斂")
  })

  test("deleting a bot removes its profile and session", () => {
    registry = new BotRegistry(":memory:")
    const bot = registry.create(owner, { name: "待刪除", role: "測試" })
    registry.saveSession({ botId: bot.id, appServerThreadId: "thread-del-1", activeRuntimeTier: "none" })

    expect(registry.getProfile(bot.id, owner)).not.toBeNull()
    expect(registry.getSession(bot.id)).not.toBeNull()

    const result = registry.delete(bot.id, owner)
    expect(result).toBeTrue()
    expect(registry.getProfile(bot.id, owner)).toBeNull()
    expect(registry.getSession(bot.id)).toBeNull()
    expect(registry.list(owner).find((b) => b.id === bot.id)).toBeUndefined()
    expect(() => registry!.delete(bot.id, owner)).toThrow("BOT_NOT_FOUND")
  })

})
