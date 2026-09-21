import { expect, test } from "bun:test"

import { E2BDesktopDriver, type E2BDesktopSdk } from "./desktop-driver"

function fakeDesktop(): { desktop: E2BDesktopSdk; calls: Array<unknown> } {
  const calls: Array<unknown> = []
  return {
    calls,
    desktop: {
      async screenshot() { calls.push(["screenshot"]); return new Uint8Array([137, 80, 78, 71]) },
      async leftClick(x, y) { calls.push(["click", x, y]) },
      async doubleClick(x, y) { calls.push(["double_click", x, y]) },
      async rightClick(x, y) { calls.push(["right_click", x, y]) },
      async write(text, options) { calls.push(["type", text, options]) },
      async press(keys) { calls.push(["key", keys]) },
      async scroll(direction, amount) { calls.push(["scroll", direction, amount]) },
      async getScreenSize() { calls.push(["screen"]); return { width: 1440, height: 900 } },
    },
  }
}

function driver(desktop: E2BDesktopSdk) {
  return new E2BDesktopDriver(desktop, { runtimeSessionId: "session", tenantId: "tenant", subjectId: "subject", actingClientId: "client" })
}

const botA = "bot-a"
const botB = "bot-b"

async function observe(subject: E2BDesktopDriver, actorBotId = botA) {
  return subject.execute({ operation: "screenshot" }, { actorBotId })
}

test("E2B adapter maps the governed computer operations to the desktop SDK", async () => {
  const fixture = fakeDesktop()
  const subject = driver(fixture.desktop)
  expect((await observe(subject)).revision).toBe(1)
  expect((await subject.execute({ operation: "click", x: 10, y: 20 }, { actorBotId: botA, expectedRevision: 1 })).revision).toBe(2)
  await subject.execute({ operation: "double_click", x: 30, y: 40 }, { actorBotId: botA, expectedRevision: (await observe(subject)).revision })
  await subject.execute({ operation: "right_click", x: 50, y: 60 }, { actorBotId: botA, expectedRevision: (await observe(subject)).revision })
  await subject.execute({ operation: "type", text: "hello" }, { actorBotId: botA, expectedRevision: (await observe(subject)).revision })
  await subject.execute({ operation: "key", keys: ["ctrl", "a"] }, { actorBotId: botA, expectedRevision: (await observe(subject)).revision })
  await subject.execute({ operation: "scroll", direction: "down", amount: 2 }, { actorBotId: botA, expectedRevision: (await observe(subject)).revision })
  expect(fixture.calls).toEqual([
    ["screenshot"],
    ["screen"], ["click", 10, 20],
    ["screenshot"], ["screen"], ["double_click", 30, 40],
    ["screenshot"], ["screen"], ["right_click", 50, 60],
    ["screenshot"], ["type", "hello", { chunkSize: 25, delayInMs: 10 }],
    ["screenshot"], ["key", ["ctrl", "a"]],
    ["screenshot"], ["scroll", "down", 2],
  ])
})

test("E2B adapter rejects stale observations, invalid coordinates, and use after cleanup", async () => {
  const fixture = fakeDesktop()
  const subject = driver(fixture.desktop)
  await observe(subject)
  await expect(subject.execute({ operation: "click", x: 10, y: 10 }, { actorBotId: botA, expectedRevision: 0 })).rejects.toThrow("COMPUTER_OBSERVATION_STALE")
  await expect(subject.execute({ operation: "click", x: 1440, y: 10 }, { actorBotId: botA, expectedRevision: 1 })).rejects.toThrow("COMPUTER_COORDINATES_INVALID")
  await expect(subject.execute({ operation: "key", keys: ["enter"] }, { actorBotId: botA, expectedRevision: 1, assertCurrent: () => { throw new Error("RUNTIME_SESSION_CHANGED") } })).rejects.toThrow("RUNTIME_SESSION_CHANGED")
  await subject.close()
  await expect(observe(subject)).rejects.toThrow("COMPUTER_DRIVER_CLOSED")
})

test("E2B adapter advances the observation after an attempted mutating operation fails", async () => {
  const fixture = fakeDesktop()
  fixture.desktop.write = async () => { throw new Error("DESKTOP_WRITE_INTERRUPTED") }
  const subject = driver(fixture.desktop)
  await observe(subject)
  await expect(subject.execute({ operation: "type", text: "partial" }, { actorBotId: botA, expectedRevision: 1 })).rejects.toThrow("DESKTOP_WRITE_INTERRUPTED")
  await expect(subject.execute({ operation: "screenshot" }, { actorBotId: botA, expectedRevision: 1 })).rejects.toThrow("COMPUTER_OBSERVATION_STALE")
})

test("E2B adapter binds a screenshot observation to the Bot that captured it", async () => {
  const subject = driver(fakeDesktop().desktop)
  const first = await observe(subject, botA)
  await expect(subject.execute({ operation: "click", x: 1, y: 1 }, { actorBotId: botB, expectedRevision: first.revision })).rejects.toThrow("COMPUTER_OBSERVATION_BOT_MISMATCH")
  const second = await observe(subject, botB)
  await expect(subject.execute({ operation: "click", x: 1, y: 1 }, { actorBotId: botA, expectedRevision: first.revision })).rejects.toThrow("COMPUTER_OBSERVATION_STALE")
  await expect(subject.execute({ operation: "click", x: 1, y: 1 }, { actorBotId: botB, expectedRevision: second.revision })).resolves.toMatchObject({ revision: second.revision + 1 })
})
