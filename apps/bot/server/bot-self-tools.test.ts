import { afterEach, describe, expect, mock, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { BotRegistry } from "./bot-registry"
import { executeSelfTool } from "./bot-self-tools"
import type { BotToolExecution } from "./bot-tool-contract"
import type { GenioPrincipal } from "./runtime-broker"

const owner: GenioPrincipal = {
  tenant_id: "tenant-self-tools",
  subject_id: "person-owner",
  acting_client_id: "genio-one-bot",
  scopes: ["genioone-invocation"],
}

const other: GenioPrincipal = { ...owner, subject_id: "person-other" }

function descriptor(name: string, description = "Release notes workflow") {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\nUse the release process.\n`
}

function response(value: Awaited<ReturnType<typeof executeSelfTool>>) {
  const item = value.content.find((content) => content.type === "text")
  if (!item || item.type !== "text") throw new Error("BOT_TOOL_RESPONSE_INVALID")
  return JSON.parse(item.text) as Record<string, unknown>
}

describe("Bot self tools", () => {
  const directories: string[] = []
  let registry: BotRegistry | null = null
  const originalFetch = globalThis.fetch

  afterEach(() => {
    registry?.close()
    registry = null
    globalThis.fetch = originalFetch
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  test("keeps private Skill files revisioned, isolated, and durable", () => {
    const directory = mkdtempSync(join(tmpdir(), "genio-owned-skills-"))
    directories.push(directory)
    registry = new BotRegistry(join(directory, "registry.sqlite"))
    const bot = registry.create(owner, { name: "Release Bot" })
    const files = { "SKILL.md": descriptor("release-notes"), "scripts/check.ts": "export const check = true\n" }
    const first = registry.ownedSkills.write(owner, bot.id, { skillName: "release-notes", files, expectedRevision: 0 })
    expect(first.revision).toBe(1)
    expect(() => registry!.ownedSkills.write(other, bot.id, { skillName: "release-notes", files, expectedRevision: 1 })).toThrow("BOT_NOT_FOUND")
    expect(() => registry!.ownedSkills.write(owner, bot.id, { skillName: "release-notes", files: { "SKILL.md": descriptor("release-notes"), "scripts/../steal": "no" }, expectedRevision: 1 })).toThrow("OWNED_SKILL_PATH_INVALID")
    expect(() => registry!.ownedSkills.write(owner, bot.id, { skillName: "release-notes", files, expectedRevision: 0 })).toThrow("OWNED_SKILL_REVISION_CONFLICT")
    expect(registry.ownedSkills.list(owner, bot.id)).toMatchObject([{ skillName: "release-notes", description: "Release notes workflow" }])
    const deleted = registry.ownedSkills.delete(owner, bot.id, { skillName: "release-notes", expectedRevision: 1 })
    expect(deleted).toMatchObject({ revision: 2, deleted: true })
    expect(() => registry!.ownedSkills.write(owner, bot.id, { skillName: "release-notes", files, expectedRevision: 1 })).toThrow("OWNED_SKILL_REVISION_CONFLICT")
    const restored = registry.ownedSkills.write(owner, bot.id, { skillName: "release-notes", files, expectedRevision: 2 })
    expect(restored.revision).toBe(3)
    expect(registry.ownedSkills.revisions(owner, bot.id, "release-notes")).toMatchObject([
      { revision: 3, deleted: false },
      { revision: 2, deleted: true },
      { revision: 1, deleted: false },
    ])
    expect(() => registry!.ownedSkills.revert(owner, bot.id, { skillName: "release-notes", revision: 2, expectedRevision: 3 })).toThrow("OWNED_SKILL_REVISION_TOMBSTONED")
    const restoredFromLiveRevision = registry.ownedSkills.revert(owner, bot.id, { skillName: "release-notes", revision: 1, expectedRevision: 3 })
    expect(restoredFromLiveRevision.revision).toBe(4)
    registry.close()
    registry = new BotRegistry(join(directory, "registry.sqlite"))
    expect(registry.ownedSkills.read(owner, bot.id, "release-notes")).toMatchObject({ revision: 4, files: expect.any(Array) })
    expect(registry.ownedSkills.revisions(owner, bot.id, "release-notes").map((item) => item.revision)).toEqual([4, 3, 2, 1])
  })

  test("recovers an owned Skill tombstone revision without exposing it to another owner", async () => {
    registry = new BotRegistry(":memory:")
    const bot = registry.create(owner, { name: "Tombstone Skill Bot" })
    const execution = { context: { botRegistry: registry }, botId: bot.id, principal: owner, accessToken: "token" } as BotToolExecution
    const foreignExecution = { ...execution, principal: other }
    const files = { "SKILL.md": descriptor("release-notes") }
    registry.ownedSkills.write(owner, bot.id, { skillName: "release-notes", files, expectedRevision: 0 })
    registry.ownedSkills.delete(owner, bot.id, { skillName: "release-notes", expectedRevision: 1 })

    expect(registry.ownedSkills.list(owner, bot.id)).toEqual([])
    const tombstone = await executeSelfTool("read_owned_skill", { skillName: "release-notes" }, execution)
    expect(tombstone.isError).not.toBe(true)
    expect(response(tombstone)).toMatchObject({
      skill: { skillName: "release-notes", revision: 2, deleted: true, files: [] },
    })
    expect(response(tombstone).revisions).toEqual(expect.arrayContaining([expect.objectContaining({ revision: 2, deleted: true })]))
    const foreignRead = await executeSelfTool("read_owned_skill", { skillName: "release-notes" }, foreignExecution)
    expect(foreignRead.isError).toBe(true)
    expect(response(foreignRead)).toMatchObject({ error: "BOT_NOT_FOUND" })

    const recreated = await executeSelfTool("write_owned_skill", { skillName: "release-notes", files, expectedRevision: 2 }, execution)
    expect(recreated.isError).not.toBe(true)
    expect(response(recreated)).toMatchObject({ skill: { skillName: "release-notes", revision: 3, deleted: false }, pendingApply: true })
    expect(registry.ownedSkills.list(owner, bot.id)).toMatchObject([{ skillName: "release-notes", revision: 3 }])
  })

  test("updates only the owner-bound profile using a compare-and-swap revision", async () => {
    registry = new BotRegistry(":memory:")
    const bot = registry.create(owner, { name: "Ops", title: "Operations", description: "Handle operations" })
    const execution = { context: { botRegistry: registry }, botId: bot.id, principal: owner, accessToken: "token" } as BotToolExecution
    const read = await executeSelfTool("read_self", {}, execution)
    expect(read.isError).not.toBe(true)
    expect(response(read).bot).toMatchObject({ id: bot.id, revision: 1 })
    const updated = await executeSelfTool("update_self", { expectedRevision: 1, title: "Incident Operations", antiJobs: "Do not deploy" }, execution)
    expect(response(updated)).toMatchObject({ revision: 2, pendingApply: true, applyState: "PENDING_RUNTIME_REFRESH" })
    expect(registry.getOwned(bot.id, owner)).toMatchObject({ title: "Incident Operations", antiJobs: "Do not deploy", revision: 2 })
    const stale = await executeSelfTool("update_self", { expectedRevision: 1, voice: "calm" }, execution)
    expect(stale.isError).toBe(true)
    expect(response(stale)).toMatchObject({ error: "BOT_PROFILE_REVISION_CONFLICT" })
    const rejected = await executeSelfTool("update_self", { expectedRevision: 2, allowedTools: ["computer"] }, execution)
    expect(rejected.isError).toBe(true)
    expect(response(rejected)).toMatchObject({ error: "BOT_TOOL_ARGUMENTS_INVALID" })
    const restored = await executeSelfTool("update_self", { expectedRevision: 2, restoreRevision: 1 }, execution)
    expect(response(restored)).toMatchObject({ revision: 3 })
    expect(registry.getOwned(bot.id, owner)?.title).toBe("Operations")
  })

  test("adds a discovered enterprise capability only for an owned Bot and returns resumable catalog states", async () => {
    registry = new BotRegistry(":memory:")
    const source = registry.create(owner, { name: "Source" })
    const target = registry.create(owner, { name: "Weekly brief" })
    const foreign = registry.create(other, { name: "Private" })
    const execution = { context: { botRegistry: registry }, botId: source.id, principal: owner, accessToken: "owner-token" } as BotToolExecution
    const originalOrigin = process.env.GENIO_ONE_PLATFORM_ORIGIN
    process.env.GENIO_ONE_PLATFORM_ORIGIN = "http://platform.test"
    const connectionRequests: string[] = []
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/catalog")) return Response.json({ capabilities: [
        { resource_id: "notion", resource_display_name: "Notion", capability_id: "notion.write", access: "AUTO_GRANT", hub_status: "AVAILABLE", connection_status: "IDLE" },
        { resource_id: "service-fixture", resource_display_name: "Fixture service", capability_id: "fixture.read", access: "AUTO_GRANT", hub_status: "CONNECTED", connection_status: "READY" },
        { resource_id: "oauth-notion", resource_display_name: "Notion personal", capability_id: "notion.search", access: "AUTO_GRANT", hub_status: "CONNECTED", connection_status: "READY" },
        { resource_id: "mail", resource_display_name: "Mail", capability_id: "mail.search", access: "ENTITLED", hub_status: "AVAILABLE", connection_status: "UNAVAILABLE" },
        { resource_id: "case", resource_display_name: "Case", capability_id: "case.read", access: "REQUEST", hub_status: "AVAILABLE", connection_status: "READY" },
      ] })
      connectionRequests.push(String(input))
      if (String(input).includes("/me/resource-connections/oauth-notion")) return Response.json([
        { connection_id: "oauth-notion-user", display_name: "Notion", authentication: "OAUTH", status: "NEEDS_CONNECTION" },
      ])
      if (String(input).includes("/me/resource-connections/")) return Response.json([])
      return new Response("not found", { status: 404 })
    }) as unknown as typeof fetch
    try {
      const installArgs = { botId: target.id, resourceId: "notion", capabilityId: "notion.write" }
      const installed = response(await executeSelfTool("add_enterprise_resource", installArgs, execution))
      expect(installed).toMatchObject({ addState: "AUTO_GRANT", binding: { state: "INSTALLED", resourceId: "notion", capabilityId: "notion.write" }, pendingApply: true, applyState: "PENDING_RUNTIME_REFRESH" })
      const repeated = response(await executeSelfTool("add_enterprise_resource", installArgs, execution))
      expect(repeated.binding).toMatchObject({ id: (installed.binding as Record<string, unknown>).id, state: "INSTALLED" })
      expect(registry.getOwned(target.id, owner)?.bindings).toHaveLength(1)

      const service = response(await executeSelfTool("add_enterprise_resource", { botId: target.id, resourceId: "service-fixture", capabilityId: "fixture.read" }, execution))
      expect(service).toMatchObject({ addState: "CONNECTED", binding: { state: "INSTALLED", resourceId: "service-fixture" } })

      const personalConnection = response(await executeSelfTool("add_enterprise_resource", { botId: target.id, resourceId: "oauth-notion", capabilityId: "notion.search" }, execution))
      expect(personalConnection).toMatchObject({ addState: "NEEDS_CONNECTION", connection: { resourceId: "oauth-notion", resourceName: "Notion personal" } })

      connectionRequests.splice(0)
      const needsConnection = response(await executeSelfTool("add_enterprise_resource", { botId: target.id, resourceId: "mail", capabilityId: "mail.search" }, execution))
      expect(needsConnection).toMatchObject({
        addState: "NEEDS_CONNECTION",
        connection: { required: true, resourceId: "mail", resourceName: "Mail", scope: "account", reusableAcrossBots: true },
        resume: { tool: "add_enterprise_resource", arguments: { botId: target.id, resourceId: "mail", capabilityId: "mail.search" } },
      })
      expect(connectionRequests).toEqual(["http://platform.test/v1/tenants/tenant-self-tools/me/resource-connections/mail"])
      expect(registry.getOwned(target.id, owner)?.bindings).toHaveLength(2)

      const requested = response(await executeSelfTool("add_enterprise_resource", { botId: target.id, resourceId: "case", capabilityId: "case.read" }, execution))
      expect(requested).toMatchObject({ addState: "REQUEST", binding: { state: "PENDING", reason: "access_request_required" }, pendingApply: true })

      const denied = response(await executeSelfTool("add_enterprise_resource", { botId: target.id, resourceId: "missing", capabilityId: "missing.read" }, execution))
      expect(denied).toMatchObject({ addState: "DENIED", error: "BOT_ACCESS_DENIED", reason: "capability_not_in_catalog" })
      expect(registry.getOwned(target.id, owner)?.bindings).toHaveLength(4)

      const foreignResult = response(await executeSelfTool("add_enterprise_resource", { botId: foreign.id, resourceId: "notion", capabilityId: "notion.write" }, execution))
      expect(foreignResult).toMatchObject({ error: "BOT_NOT_FOUND" })
    } finally {
      if (originalOrigin === undefined) delete process.env.GENIO_ONE_PLATFORM_ORIGIN
      else process.env.GENIO_ONE_PLATFORM_ORIGIN = originalOrigin
    }
  })

  test("parses quoted and multiline YAML Skill frontmatter while rejecting invalid descriptors", () => {
    registry = new BotRegistry(":memory:")
    const bot = registry.create(owner, { name: "YAML Bot" })
    const descriptor = "---\r\nname: \"quoted-skill\"\r\ndescription: |\r\n  First line\r\n  Second line\r\n---\r\n\r\nUse the skill.\r\n"
    registry.ownedSkills.write(owner, bot.id, { skillName: "quoted-skill", expectedRevision: 0, files: { "SKILL.md": descriptor } })
    expect(registry.ownedSkills.list(owner, bot.id)).toMatchObject([{ skillName: "quoted-skill", description: "First line\nSecond line\n" }])
    expect(() => registry!.ownedSkills.write(owner, bot.id, {
      skillName: "invalid-skill",
      expectedRevision: 0,
      files: { "SKILL.md": "---\nname: invalid-skill\ndescription: [unterminated\n---\n" },
    })).toThrow("OWNED_SKILL_FRONTMATTER_INVALID")
    expect(() => registry!.ownedSkills.write(owner, bot.id, {
      skillName: "missing-close",
      expectedRevision: 0,
      files: { "SKILL.md": "---\nname: missing-close\ndescription: Missing closing delimiter\n" },
    })).toThrow("OWNED_SKILL_FRONTMATTER_INVALID")
  })

  test("keeps owned Skills outside an installed package artifact", () => {
    const directory = mkdtempSync(join(tmpdir(), "genio-owned-package-"))
    directories.push(directory)
    const previousPackageRoot = process.env.GENIO_BOT_PACKAGE_STORE
    process.env.GENIO_BOT_PACKAGE_STORE = join(directory, "packages")
    try {
      registry = new BotRegistry(join(directory, "registry.sqlite"))
      const installed = registry.install(owner, "genio.demo.bot")
      const packageOnly = registry.materialize(installed.id, owner)
      const packageDescriptor = readFileSync(join(packageOnly.skillRoots[0]!, "SKILL.md"), "utf8")
      registry.ownedSkills.write(owner, installed.id, { skillName: "release-notes", expectedRevision: 0, files: { "SKILL.md": descriptor("release-notes") } })
      const combined = registry.materialize(installed.id, owner)
      expect(combined.skillRoots).toHaveLength(1)
      expect(combined.skillRoots[0]).toBe(packageOnly.skillRoots[0])
      expect(readFileSync(join(combined.skillRoots[0]!, "SKILL.md"), "utf8")).toBe(packageDescriptor)
    } finally {
      if (previousPackageRoot === undefined) delete process.env.GENIO_BOT_PACKAGE_STORE
      else process.env.GENIO_BOT_PACKAGE_STORE = previousPackageRoot
    }
  })

  test("creates a private same-owner Bot once for one durable request id", async () => {
    registry = new BotRegistry(":memory:")
    const source = registry.create(owner, { name: "Source", modelRoute: "genio-gateway", skills: ["installed-skill"] })
    const execution = { context: { botRegistry: registry }, botId: source.id, principal: owner, accessToken: "owner-token" } as BotToolExecution
    let registrations = 0
    globalThis.fetch = mock(async () => {
      registrations += 1
      return Response.json({ subject_id: "agent-new", kind: "AGENT" }, { status: 201 })
    }) as unknown as typeof fetch
    const args = { clientRequestId: "request-1", name: "Private Child", title: "Child" }
    const first = await executeSelfTool("create_bot", args, execution)
    expect(first.isError).not.toBe(true)
    const created = response(first).bot as Record<string, unknown>
    expect(created).toMatchObject({ name: "Private Child" })
    const child = registry.getOwned(String(created.id), owner)!
    expect(child).toMatchObject({ ownerSubjectId: owner.subject_id, tenantId: owner.tenant_id, modelRoute: "genio-gateway", skills: [], bindings: [] })
    expect(child.sharePolicy.visibility).toBe("PRIVATE")
    const second = await executeSelfTool("create_bot", args, execution)
    expect(response(second)).toMatchObject({ created: false, bot: { id: child.id } })
    expect(registrations).toBe(1)
    const mismatched = await executeSelfTool("create_bot", { ...args, name: "Different Child" }, execution)
    expect(mismatched.isError).toBe(true)
    expect(response(mismatched)).toMatchObject({ error: "BOT_CREATE_REQUEST_CONFLICT" })
    const forbidden = await executeSelfTool("create_bot", { ...args, clientRequestId: "request-2", schedules: [{}] }, execution)
    expect(forbidden.isError).toBe(true)
    expect(response(forbidden)).toMatchObject({ error: "BOT_TOOL_ARGUMENTS_INVALID" })
  })

  test("reserves create ids only after usage resolution and recovers an uncertain registration", async () => {
    registry = new BotRegistry(":memory:")
    const contextualOwner = { ...owner, organization_ids: ["org-engineering"] }
    const source = registry.create(contextualOwner, { name: "Source", modelRoute: "genio-gateway" })
    const execution = { context: { botRegistry: registry }, botId: source.id, principal: contextualOwner, accessToken: "owner-token" } as BotToolExecution
    const args = { clientRequestId: "recoverable-request", name: "Child" }
    globalThis.fetch = mock(async () => { throw new Error("usage unavailable") }) as unknown as typeof fetch
    const unavailable = await executeSelfTool("create_bot", args, execution)
    expect(unavailable.isError).toBe(true)
    let calls = 0
    globalThis.fetch = mock(async (url: string | URL) => {
      calls += 1
      if (String(url).includes("/use-cases")) return Response.json([{ tenant_id: owner.tenant_id, organization_id: "org-engineering", use_case_id: "use-case-1", display_name: "Engineering", state: "ACTIVE" }])
      return Response.json({ subject_id: "agent-recovered", kind: "AGENT" }, { status: 201 })
    }) as unknown as typeof fetch
    const recovered = await executeSelfTool("create_bot", args, execution)
    expect(recovered.isError).not.toBe(true)
    expect(calls).toBe(2)

    const pendingArgs = { clientRequestId: "pending-request", name: "Pending Child" }
    const remoteAgents = new Set<string>()
    let registrationCalls = 0
    globalThis.fetch = mock(async () => {
      registrationCalls += 1
      remoteAgents.add("agent-pending")
      if (registrationCalls === 1) throw new Error("registration outcome uncertain")
      return Response.json({ subject_id: "agent-pending", kind: "AGENT" }, { status: 201 })
    }) as unknown as typeof fetch
    const personal = registry.create(owner, { name: "Personal" })
    const personalExecution = { ...execution, principal: owner, botId: personal.id }
    const pending = await executeSelfTool("create_bot", pendingArgs, personalExecution)
    expect(pending.isError).toBe(true)
    const replay = await executeSelfTool("create_bot", pendingArgs, personalExecution)
    expect(replay.isError).not.toBe(true)
    expect(response(replay)).toMatchObject({ created: true, bot: { name: "Pending Child" } })
    expect(remoteAgents.size).toBe(1)
    expect(registry.list(owner).filter((bot) => bot.name === "Pending Child")).toHaveLength(1)
  })

  test("keeps completed create receipts tombstoned when their Bot is deleted or archived", async () => {
    registry = new BotRegistry(":memory:")
    const source = registry.create(owner, { name: "Source" })
    const execution = { context: { botRegistry: registry }, botId: source.id, principal: owner, accessToken: "owner-token" } as BotToolExecution
    let registrations = 0
    globalThis.fetch = mock(async () => {
      registrations += 1
      return Response.json({ subject_id: `agent-${registrations}`, kind: "AGENT" }, { status: 201 })
    }) as unknown as typeof fetch

    const deletedArgs = { clientRequestId: "deleted-receipt", name: "Deleted Child" }
    const created = response(await executeSelfTool("create_bot", deletedArgs, execution)).bot as Record<string, unknown>
    registry.delete(String(created.id), owner)
    const deletedRetry = await executeSelfTool("create_bot", deletedArgs, execution)
    expect(deletedRetry.isError).not.toBe(true)
    expect(response(deletedRetry)).toEqual({ created: false, deleted: true, applyState: "DELETED" })
    expect(registrations).toBe(1)
    const deletedConflict = await executeSelfTool("create_bot", { ...deletedArgs, name: "Different Child" }, execution)
    expect(deletedConflict.isError).toBe(true)
    expect(response(deletedConflict)).toMatchObject({ error: "BOT_CREATE_REQUEST_CONFLICT" })

    const archivedArgs = { clientRequestId: "archived-receipt", name: "Archived Child" }
    const archivedCreated = response(await executeSelfTool("create_bot", archivedArgs, execution)).bot as Record<string, unknown>
    registry.db.query("update bots set archived = 1 where id = ?").run(String(archivedCreated.id))
    const archivedRetry = await executeSelfTool("create_bot", archivedArgs, execution)
    expect(archivedRetry.isError).not.toBe(true)
    expect(response(archivedRetry)).toEqual({ created: false, deleted: true, applyState: "DELETED" })
    expect(registrations).toBe(2)
  })
})
