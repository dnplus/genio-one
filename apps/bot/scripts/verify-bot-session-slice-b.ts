/**
 * Slice B verification: BotSession thread pointer + unread/working roster projection.
 * Run: bun apps/bot/scripts/verify-bot-session-slice-b.ts
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { BotRegistry } from "../server/bot-registry"
import type { GenioPrincipal } from "../server/runtime-broker"

const owner: GenioPrincipal = {
  tenant_id: "tenant-verify-slice-b",
  subject_id: "person-verify",
  acting_client_id: "genio-one-bot",
  scopes: ["genioone-invocation"],
}

const dir = mkdtempSync(join(tmpdir(), "slice-b-bot-session-"))
const registry = new BotRegistry(join(dir, "registry.sqlite"), join(dir, "artifacts"))

try {
  const aqua = registry.create(owner, {
    name: "阿庫婭",
    title: "切片 B 驗證",
    description: "三欄 shell + server BotSession；重整後 thread 仍在。",
  })
  const darkness = registry.create(owner, {
    name: "達克妮絲",
    title: "切換對象",
    description: "切換 Bot 不丟另一隻的 server session。",
  })

  registry.saveSession({
    botId: aqua.id,
    appServerThreadId: "thread-aqua-persist",
    activeRuntimeTier: "none",
    memoryPointer: "memory://aqua",
  })
  registry.saveSession({
    botId: darkness.id,
    appServerThreadId: "thread-dark-persist",
    activeRuntimeTier: "headless",
  })

  registry.applySessionEvent(aqua.id, "turn_started")
  if (registry.getSession(aqua.id)?.workState !== "working") throw new Error("expected working")
  registry.applySessionEvent(aqua.id, "turn_completed")
  const afterComplete = registry.getSession(aqua.id)!
  if (!afterComplete.unread || afterComplete.workState !== "idle") throw new Error("expected unread idle")
  if (afterComplete.appServerThreadId !== "thread-aqua-persist") throw new Error("thread pointer lost on event")

  // Simulate switch bots: darkness session must remain
  if (registry.getSession(darkness.id)?.appServerThreadId !== "thread-dark-persist") {
    throw new Error("switching focus lost other bot session")
  }

  registry.applySessionEvent(aqua.id, "viewed")
  if (registry.getSession(aqua.id)?.unread) throw new Error("viewed should clear unread")

  // Clear "browser storage" simulation: reopen sqlite
  registry.close()
  const again = new BotRegistry(join(dir, "registry.sqlite"), join(dir, "artifacts"))
  const roster = again.listRoster(owner)
  again.close()
  if (roster.length !== 2) throw new Error("roster lost after reopen")
  const aquaLive = roster.find((entry) => entry.bot.id === aqua.id)?.session
  const darkLive = roster.find((entry) => entry.bot.id === darkness.id)?.session
  if (!aquaLive || aquaLive.appServerThreadId !== "thread-aqua-persist") {
    throw new Error("session not durable after reopen")
  }
  if (aquaLive.memoryPointer !== "memory://aqua") throw new Error("memory pointer lost")
  if (!darkLive || darkLive.appServerThreadId !== "thread-dark-persist") {
    throw new Error("peer bot session lost after reopen")
  }
  if (aquaLive.unread) throw new Error("unread should stay cleared after reopen")

  console.log("OK slice B BotSession + roster projection")
  console.log(JSON.stringify({
    aquaId: aqua.id,
    darknessId: darkness.id,
    aquaSession: aquaLive,
    darkSession: darkLive,
    rosterCount: roster.length,
  }, null, 2))
} finally {
  rmSync(dir, { recursive: true, force: true })
}
