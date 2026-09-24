import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotRegistry } from "./bot-registry"
import { BotWorkspaceStore } from "./bot-workspace-store"

test("workspace identity and checkpoint survive runtime release and Bot deletion remains recoverable by owner", () => {
  const root = mkdtempSync(join(tmpdir(), "genio-hands-workspace-"))
  const databasePath = join(root, "bots.sqlite")
  const principal = { tenant_id: "tenant-a", subject_id: "owner-a", acting_client_id: "client-a", scopes: [] }
  const other = { ...principal, subject_id: "owner-b" }
  let workspaceId = ""
  try {
    const registry = new BotRegistry(databasePath, join(root, "artifacts"))
    const workspaces = new BotWorkspaceStore(registry.db, (botId, owner) => registry.getOwned(botId, owner), join(root, "workspaces"))
    const bot = registry.create(principal, { name: "Hands", description: "Workspace owner" })
    const workspace = workspaces.ensureActive(principal, bot.id)
    workspaceId = workspace.workspaceId
    expect(workspace.provider).toBe("e2b-self-hosted")
    expect(workspaces.saveCheckpoint(workspaceId, 0, Buffer.from("opaque checkpoint"))).toBe(1)
    expect(workspaces.readCheckpoint(workspaceId, 1)?.toString()).toBe("opaque checkpoint")
    expect(workspaces.create(principal, bot.id, "cloudflare-hands").workspaceId).not.toBe(workspaceId)
    expect(workspaces.setActive(principal, bot.id, workspaceId).workspaceId).toBe(workspaceId)
    expect(workspaces.active(principal, bot.id)?.revision).toBe(1)
    expect(registry.delete(bot.id, principal)).toBe(true)
    expect(workspaces.recoverable(principal).some((entry) => entry.workspaceId === workspaceId)).toBe(true)
    expect(workspaces.recoverable(other)).toEqual([])
    expect(workspaces.getRecoverable(other, workspaceId)).toBeNull()
    registry.close()

    const reopened = new BotRegistry(databasePath, join(root, "artifacts"))
    const recovered = new BotWorkspaceStore(reopened.db, (botId, owner) => reopened.getOwned(botId, owner), join(root, "workspaces"))
    expect(recovered.getRecoverable(principal, workspaceId)?.revision).toBe(1)
    expect(recovered.readCheckpoint(workspaceId, 1)?.toString()).toBe("opaque checkpoint")
    reopened.close()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("one isolate request is coalesced and different writes remain fenced", async () => {
  const root = mkdtempSync(join(tmpdir(), "genio-hands-isolate-"))
  try {
    const registry = new BotRegistry(":memory:", join(root, "artifacts"))
    const workspaces = new BotWorkspaceStore(registry.db, (botId, owner) => registry.getOwned(botId, owner), join(root, "workspaces"))
    const principal = { tenant_id: "tenant-a", subject_id: "owner-a", acting_client_id: "client-a", scopes: [] }
    const bot = registry.create(principal, { name: "Hands", description: "Isolate owner" })
    const workspace = workspaces.create(principal, bot.id, "cloudflare-hands")
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let executions = 0
    const requestId = "b4b39950-60bf-42a0-a41b-12b6d9ab7c8b"
    const first = workspaces.runIsolate(workspace.workspaceId, requestId, { code: "1+1" }, async () => { executions += 1; await gate; return "done" })
    const repeat = workspaces.runIsolate(workspace.workspaceId, requestId, { code: "1+1" }, async () => { executions += 1; return "replayed" })
    expect(repeat).toBe(first)
    expect(workspaces.hasInFlightForBot(bot.id)).toBe(true)
    expect(() => workspaces.runIsolate(workspace.workspaceId, requestId, { code: "2+2" }, async () => "changed")).toThrow("HANDS_REQUEST_ID_CONFLICT")
    expect(() => workspaces.runIsolate(workspace.workspaceId, "9c6a1d18-61ac-489f-9cca-0dfe5e3070d8", { code: "3+3" }, async () => "other")).toThrow("WORKSPACE_BUSY")
    release()
    expect(await first).toBe("done")
    expect(executions).toBe(1)
    expect(workspaces.hasInFlightForBot(bot.id)).toBe(false)
    registry.close()
  } finally { rmSync(root, { recursive: true, force: true }) }
})
