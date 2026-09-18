/**
 * UX P1-a verification: Bot↔Bot async handoff ack + visible event + FYI silent + no mindless fan-out.
 * Run: bun apps/bot/scripts/verify-bot-ux-p1a.ts
 */
import { BotRegistry } from "../server/bot-registry"
import {
  HandoffFanOutError,
  projectHandoffMessages,
  resolveHandoffTargets,
  resolveHandoffVisibility,
} from "../server/bot-handoff"
import type { GenioPrincipal } from "../server/runtime-broker"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const owner: GenioPrincipal = {
  tenant_id: "tenant-verify-p1a",
  subject_id: "person-verify",
  acting_client_id: "genio-one-bot",
  scopes: ["genioone-invocation"],
}

const registry = new BotRegistry(":memory:")

try {
  // Pure helpers
  assert(resolveHandoffVisibility("fyi") === "silent", "FYI silent default")
  assert(resolveHandoffVisibility("task") === "visible", "task visible default")
  let threw = false
  try {
    resolveHandoffTargets({ fromBotId: "a", fact: "x", toBotIds: ["b", "c"] })
  } catch (error) {
    threw = error instanceof HandoffFanOutError
  }
  assert(threw, "fan-out without explicit must throw")

  const aqua = registry.create(owner, { name: "阿庫婭", title: "Aqua", description: "P1-a 發起" })
  const darkness = registry.create(owner, { name: "達克妮絲", title: "Darkness", description: "P1-a 接收" })
  const megumin = registry.create(owner, { name: "惠惠", title: "Megumin", description: "P1-a 旁觀" })

  const ack = registry.createHandoff(owner, {
    fromBotId: aqua.id,
    toBotId: darkness.id,
    fact: "事實：CS001284 = In Progress",
    kind: "task",
  })
  assert(ack.async === true && ack.processed === false, "send returns async ack, not processed")
  assert(ack.state === "ACKED", `expected ACKED got ${ack.state}`)
  assert(ack.events.some((e) => e.type === "handoff.sent"), "sent event")
  assert(ack.events.some((e) => e.type === "handoff.acked"), "acked event")

  const aquaVisible = projectHandoffMessages(registry.listHandoffEvents(owner, aqua.id))
  assert(aquaVisible.some((m) => m.kind === "handoff" && m.text.includes("稍後處理")), "user-visible handoff bubble")

  // Not delivered yet
  assert(registry.getHandoff(owner, ack.handoffId)?.processed === false, "not same-turn processed")

  // No mindless fan-out
  let fanBlocked = false
  try {
    registry.createHandoffs(owner, {
      fromBotId: aqua.id,
      toBotIds: [darkness.id, megumin.id],
      fact: "廣播?",
    })
  } catch (error) {
    fanBlocked = error instanceof HandoffFanOutError
  }
  assert(fanBlocked, "mindless fan-out blocked")

  // FYI silent on recipient
  const fyi = registry.createHandoff(owner, {
    fromBotId: aqua.id,
    toBotId: megumin.id,
    fact: "背景 FYI",
    kind: "fyi",
  })
  assert(fyi.visibility === "silent", "FYI silent")
  assert(registry.listHandoffEvents(owner, megumin.id).every((e) => e.handoffId !== fyi.handoffId), "FYI hidden from recipient visible list")
  assert(
    registry.listHandoffEvents(owner, megumin.id, { includeSilent: true }).some((e) => e.handoffId === fyi.handoffId),
    "FYI stored when includeSilent",
  )

  // Later process
  const done = registry.processHandoff(owner, ack.handoffId)
  assert(done.processed && done.state === "DELIVERED", "later process delivers")
  const darkEvents = registry.listHandoffEvents(owner, darkness.id, { includeSilent: true })
  assert(darkEvents.some((e) => e.type === "handoff.delivered" && e.fact.includes("CS001284")), "recipient got fact")

  console.log("OK UX P1-a Bot↔Bot async handoff")
  console.log(JSON.stringify({
    module: "apps/bot/server/bot-handoff.ts",
    routes: "apps/bot/server/routes/handoffs.ts",
    ack: {
      handoffId: ack.handoffId,
      async: ack.async,
      processedOnCreate: false,
      state: ack.state,
    },
    visibleBubbleSample: aquaVisible.slice(0, 2).map((m) => ({ text: m.text, kind: m.kind })),
    fyiSilent: fyi.visibility,
    fanOutBlockedWithoutExplicit: true,
    deliveredFact: "事實：CS001284 = In Progress",
    outOfScope: ["P1-b group round-robin", "P1-c sidebar", "P2 Hands", "marketplace", "Notion"],
  }, null, 2))
} finally {
  registry.close()
}
