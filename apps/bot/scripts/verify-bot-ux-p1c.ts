/**
 * UX P1-c verification: sidebar status projection working / unread / needs-attention
 * aligned with BotSession (slice B events).
 * Run: bun apps/bot/scripts/verify-bot-ux-p1c.ts
 */
import { BotRegistry } from "../server/bot-registry"
import {
  assertRosterHumanPrimaryCopy,
  projectRosterSidebarStatus,
  rosterStatusPreview,
} from "../server/bot-roster-status"
import type { GenioPrincipal } from "../server/runtime-broker"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const owner: GenioPrincipal = {
  tenant_id: "tenant-verify-p1c",
  subject_id: "person-verify",
  acting_client_id: "genio-one-bot",
  scopes: ["genioone-invocation"],
}

const registry = new BotRegistry(":memory:")

try {
  const aqua = registry.create(owner, { name: "阿庫婭", title: "Aqua", description: "P1-c working" })
  const darkness = registry.create(owner, { name: "達克妮絲", title: "Darkness", description: "P1-c unread" })
  const megumin = registry.create(owner, { name: "惠惠", title: "Megumin", description: "P1-c needs-attention" })

  // working
  registry.applySessionEvent(aqua.id, "turn_started")
  const aquaSession = registry.getSession(aqua.id)!
  const aquaProj = projectRosterSidebarStatus(aquaSession)
  assert(aquaSession.workState === "working", "session working")
  assert(aquaProj.status === "working" && aquaProj.statusLabel === "工作中", "working projection")
  assert(rosterStatusPreview(aquaSession, "x") === "工作中…", "working preview")

  // unread (turn completed → idle + unread)
  registry.applySessionEvent(darkness.id, "turn_started")
  registry.applySessionEvent(darkness.id, "turn_completed")
  const darkSession = registry.getSession(darkness.id)!
  const darkProj = projectRosterSidebarStatus(darkSession)
  assert(darkSession.unread === true && darkSession.workState === "idle", "session unread idle")
  assert(darkProj.status === "unread" && darkProj.statusLabel === "未讀動態", "unread projection")

  // needs-attention (stopped)
  registry.applySessionEvent(megumin.id, "turn_started")
  registry.applySessionEvent(megumin.id, "turn_stopped")
  const megaSession = registry.getSession(megumin.id)!
  const megaProj = projectRosterSidebarStatus(megaSession)
  assert(megaSession.workState === "stopped", "session stopped")
  assert(megaProj.status === "needs-attention" && megaProj.statusLabel === "需要注意", "needs-attention projection")
  assert(rosterStatusPreview(megaSession, "x") === "已停止，未回覆", "needs-attention preview")

  // roster list aligns with projection
  const roster = registry.listRoster(owner)
  const byId = Object.fromEntries(roster.map((e) => [e.bot.id, projectRosterSidebarStatus(e.session)]))
  assert(byId[aqua.id]?.status === "working", "roster aqua working")
  assert(byId[darkness.id]?.status === "unread", "roster darkness unread")
  assert(byId[megumin.id]?.status === "needs-attention", "roster megumin needs-attention")

  // viewed clears unread; stopped stays needs-attention until idle
  registry.applySessionEvent(darkness.id, "viewed")
  assert(projectRosterSidebarStatus(registry.getSession(darkness.id)!).status === null, "viewed clears unread")
  registry.applySessionEvent(megumin.id, "viewed")
  assert(
    projectRosterSidebarStatus(registry.getSession(megumin.id)!).status === "needs-attention",
    "viewed does not clear needs-attention while stopped",
  )
  registry.applySessionEvent(megumin.id, "turn_idle")
  assert(projectRosterSidebarStatus(registry.getSession(megumin.id)!).status === null, "idle clears attention")

  assertRosterHumanPrimaryCopy(
    aquaProj.statusLabel,
    darkProj.statusLabel,
    megaProj.statusLabel,
    rosterStatusPreview(megaSession, ""),
  )

  console.log("OK UX P1-c sidebar status projection")
  console.log(JSON.stringify({
    module: "apps/bot/server/bot-roster-status.ts",
    sidebar: "apps/bot/src/components/sidebar/Sidebar.tsx",
    states: {
      working: aquaProj,
      unread: darkProj,
      "needs-attention": megaProj,
    },
    rosterAligned: true,
    outOfScope: ["P2 Hands", "activity feed", "marketplace", "Notion"],
  }, null, 2))
} finally {
  registry.close()
}
