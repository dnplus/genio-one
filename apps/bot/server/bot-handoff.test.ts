import { afterEach, describe, expect, test } from "bun:test"

import { BotRegistry } from "./bot-registry"
import {
  HandoffFanOutError,
  handoffBubbleText,
  projectHandoffMessages,
  resolveHandoffTargets,
  resolveHandoffVisibility,
} from "./bot-handoff"
import type { GenioPrincipal } from "./runtime-broker"

const owner: GenioPrincipal = {
  tenant_id: "tenant-keycloak-local",
  subject_id: "person-owner",
  acting_client_id: "genio-one-bot",
  scopes: ["genioone-invocation"],
}

describe("UX P1-a Bot↔Bot async handoff", () => {
  let registry: BotRegistry | null = null
  afterEach(() => registry?.close())

  test("resolveHandoffTargets refuses mindless fan-out", () => {
    expect(() => resolveHandoffTargets({ fromBotId: "a", fact: "x", toBotIds: ["b", "c"] })).toThrow(HandoffFanOutError)
    expect(resolveHandoffTargets({ fromBotId: "a", fact: "x", toBotId: "b" })).toEqual(["b"])
    expect(resolveHandoffTargets({
      fromBotId: "a",
      fact: "x",
      toBotIds: ["b", "c"],
      fanOutExplicit: true,
    })).toEqual(["b", "c"])
  })

  test("FYI defaults silent; task defaults visible", () => {
    expect(resolveHandoffVisibility("fyi")).toBe("silent")
    expect(resolveHandoffVisibility("task")).toBe("visible")
    expect(resolveHandoffVisibility("fyi", "visible")).toBe("visible")
  })

  test("send ack immediately; process later; user-visible bubble; no fan-out", () => {
    registry = new BotRegistry(":memory:")
    const aqua = registry.create(owner, { name: "阿庫婭", title: "Aqua", description: "交接發起" })
    const darkness = registry.create(owner, { name: "達克妮絲", title: "Darkness", description: "交接接收" })
    const megumin = registry.create(owner, { name: "惠惠", title: "Megumin", description: "不應被無腦廣播" })

    const before = Date.now()
    const ack = registry.createHandoff(owner, {
      fromBotId: aqua.id,
      toBotId: darkness.id,
      fact: "Case CS001284 狀態為 In Progress",
      kind: "task",
    })
    const afterCreate = Date.now()

    expect(ack.async).toBe(true)
    expect(ack.processed).toBe(false)
    expect(ack.state).toBe("ACKED")
    expect(ack.fromBotId).toBe(aqua.id)
    expect(ack.toBotId).toBe(darkness.id)
    expect(ack.events.some((e) => e.type === "handoff.sent")).toBe(true)
    expect(ack.events.some((e) => e.type === "handoff.acked")).toBe(true)
    // Not processed in same create call
    expect(registry.getHandoff(owner, ack.handoffId)?.processed).toBe(false)
    expect(afterCreate - before).toBeLessThan(5_000)

    const visibleAqua = registry.listHandoffEvents(owner, aqua.id)
    expect(visibleAqua.length).toBeGreaterThan(0)
    const bubbles = projectHandoffMessages(visibleAqua)
    expect(bubbles.some((b) => b.kind === "handoff" && b.text.includes("已確認送出"))).toBe(true)

    // Mindless fan-out blocked
    expect(() => registry!.createHandoffs(owner, {
      fromBotId: aqua.id,
      toBotIds: [darkness.id, megumin.id],
      fact: "不應廣播",
    })).toThrow(HandoffFanOutError)

    // Explicit fan-out allowed (one ack per target)
    const fan = registry.createHandoffs(owner, {
      fromBotId: aqua.id,
      toBotIds: [darkness.id, megumin.id],
      fanOutExplicit: true,
      fact: "明示多播事實",
      kind: "task",
    })
    expect(fan).toHaveLength(2)
    expect(fan.every((item) => item.async && !item.processed)).toBe(true)

    // Later process (separate call)
    const processed = registry.processHandoff(owner, ack.handoffId)
    expect(processed.processed).toBe(true)
    expect(processed.state).toBe("DELIVERED")
    expect(registry.getHandoff(owner, ack.handoffId)?.processed).toBe(true)

    const darknessEvents = registry.listHandoffEvents(owner, darkness.id, { includeSilent: true })
    expect(darknessEvents.some((e) => e.type === "handoff.delivered" && e.fact.includes("CS001284"))).toBe(true)
    expect(registry.getSession(darkness.id)?.unread).toBe(true)
  })

  test("FYI can be silent on recipient while sender still sees ack", () => {
    registry = new BotRegistry(":memory:")
    const aqua = registry.create(owner, { name: "阿庫婭", description: "發起" })
    const darkness = registry.create(owner, { name: "達克妮絲", description: "接收" })

    const ack = registry.createHandoff(owner, {
      fromBotId: aqua.id,
      toBotId: darkness.id,
      fact: "僅供參考的背景",
      kind: "fyi",
    })
    expect(ack.visibility).toBe("silent")
    expect(ack.events.every((e) => e.visibility === "visible")).toBe(true)

    const recipientVisible = registry.listHandoffEvents(owner, darkness.id)
    expect(recipientVisible.filter((e) => e.handoffId === ack.handoffId)).toHaveLength(0)

    const recipientAll = registry.listHandoffEvents(owner, darkness.id, { includeSilent: true })
    expect(recipientAll.some((e) => e.handoffId === ack.handoffId && e.visibility === "silent")).toBe(true)

    // silent FYI should not force unread via visibility path — create still may not mark
    // (markTargetUnread only when visible)
  })

  test("handoff bubble copy stays user-facing", () => {
    expect(handoffBubbleText({
      type: "handoff.acked",
      kind: "task",
      summary: "x",
      fact: "y",
    })).toContain("稍後處理")
    expect(handoffBubbleText({
      type: "handoff.delivered",
      kind: "task",
      summary: "x",
      fact: "事實A",
    })).toContain("事實A")
  })
})
