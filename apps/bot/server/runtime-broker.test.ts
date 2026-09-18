import { describe, expect, test } from "bun:test"

import { RuntimeBroker, type GenioPrincipal, type RuntimeProvider } from "./runtime-broker"
import type { ManagedDesktop, RuntimeProvisionRequest, RuntimeCallbacks } from "./runtime"

const principal: GenioPrincipal = {
  tenant_id: "tenant-keycloak-local",
  subject_id: "person-platform-admin",
  acting_client_id: "genio-one-bot",
  scopes: ["genioone-invocation"],
}

function execDesktop(sandboxId: string): ManagedDesktop {
  return {
    details: {
      kind: "e2b-self-hosted",
      tier: "headless",
      cwd: "/home/user",
      desktopUrl: null,
      sandboxId,
      environmentId: `e2b-${sandboxId}`,
      execServerUrl: "ws://executor.test",
      execReady: true,
    },
    async close() {},
  }
}

describe("RuntimeBroker", () => {
  test("shutdown awaits runtime closure and rejects new work", async () => {
    const broker = new RuntimeBroker({ provision: async () => execDesktop("shutdown") })
    let finishClose!: () => void
    const closed = new Promise<void>((resolve) => { finishClose = resolve })
    const session = await broker.start(principal, { onMessage() {}, onExit() {} }, () => ({ send: async () => {}, close: () => closed }))
    let finished = false
    const shutdown = broker.close().then(() => { finished = true })
    await Promise.resolve()
    expect(finished).toBe(false)
    await expect(broker.start(principal, { onMessage() {}, onExit() {} })).rejects.toThrow("RUNTIME_BROKER_CLOSING")
    await expect(broker.ensure(session.id)).rejects.toThrow("RUNTIME_BROKER_CLOSING")
    finishClose()
    await shutdown
    expect(broker.activeCount()).toBe(0)
    await broker.close()
  })
  test("restores pending questions on reattachment even when the original socket was connected when they arrived", async () => {
    const broker = new RuntimeBroker({ provision: async () => execDesktop("pending-test") })
    let callbacks: RuntimeCallbacks | undefined
    const sent: string[] = []
    const original = { onMessage() {}, onExit() {} }
    const session = await broker.start(principal, original, (events) => {
      callbacks = events
      return { send: async (line) => { sent.push(line) }, close: async () => {} }
    })
    callbacks!.onMessage(JSON.stringify({ id: 8, method: "item/tool/requestUserInput", params: { threadId: "thread-a", turnId: "turn-a", questions: [] } }))
    broker.detach(session.id, original)
    const restored = await broker.start(principal, { onMessage() {}, onExit() {} })
    expect(restored.id).toBe(session.id)
    const pending = broker.pendingInteractions(restored.id, "thread-a")
    expect(pending).toHaveLength(1)
    expect(broker.waitingFor(restored.id, ["thread-a"])).toBe("answer")
    expect(broker.waitingFor(restored.id, ["other-bot-thread"])).toBeUndefined()
    await broker.respondToInteraction(restored.id, "thread-a", pending[0]!.genioRequestToken, { answers: {} })
    expect(JSON.parse(sent[0]!)).toEqual({ id: 8, result: { answers: {} } })
    expect(broker.pendingInteractions(restored.id, "thread-a")).toEqual([])
    expect(broker.waitingFor(restored.id, ["thread-a"])).toBeUndefined()
    callbacks!.onMessage(JSON.stringify({ id: 9, method: "mcpServer/elicitation/request", params: { threadId: "thread-a", turnId: "turn-b" } }))
    expect(broker.waitingFor(restored.id, ["thread-a"])).toBe("approval")
    await broker.stop(restored.id)
    expect(broker.waitingFor(restored.id, ["thread-a"])).toBeUndefined()
  })
  test("keeps headless and desktop leases separate while sharing the server Codex session", async () => {
    const requests: RuntimeProvisionRequest[] = []
    const provider: RuntimeProvider = {
      async provision(request) {
        requests.push(request)
        return {
          details: {
            kind: "e2b-self-hosted",
            tier: request.tier,
            cwd: "/home/user",
            desktopUrl: request.tier === "desktop" ? "https://desktop.test" : null,
            sandboxId: `sandbox-${request.tier}`,
            environmentId: `e2b-${request.tier}`,
            execServerUrl: `ws://executor.test/${request.tier}`,
            execReady: true,
          },
          async close() {},
        }
      },
    }
    const broker = new RuntimeBroker(provider)
    const session = await broker.start(principal, { onMessage() {}, onExit() {} })
    await broker.ensure(session.id, "headless", "bot-a")
    await broker.ensure(session.id, "desktop", "bot-b")
    expect(requests.map((request) => [request.tier, request.botId])).toEqual([["headless", "bot-a"], ["desktop", "bot-b"]])
    expect(broker.get(session.id)?.runtimeDetails.headless?.desktopUrl).toBeNull()
    expect(broker.get(session.id)?.runtimeDetails.desktop?.desktopUrl).toBe("https://desktop.test")
    await broker.stop(session.id)
  })

  test("keeps the headless lease active when the desktop lease exits", async () => {
    let desktopExit: ((reason: string) => void) | null = null
    const events: string[] = []
    const provider: RuntimeProvider = {
      async provision(request, callbacks) {
        if (request.tier === "desktop") desktopExit = callbacks.onExit
        return {
          details: {
            kind: "e2b-self-hosted",
            tier: request.tier,
            cwd: "/home/user",
            desktopUrl: request.tier === "desktop" ? "https://desktop.test" : null,
            sandboxId: `sandbox-${request.tier}`,
            environmentId: `e2b-${request.tier}`,
            execServerUrl: "ws://executor.test",
            execReady: true,
          },
          async close() {},
        }
      },
    }
    const broker = new RuntimeBroker(provider)
    const session = await broker.start(principal, { onMessage: (message) => events.push(message), onExit() {} })
    await broker.ensure(session.id, "headless")
    await broker.ensure(session.id, "desktop")
    desktopExit!("desktop stopped")
    expect(broker.get(session.id)?.details.tier).toBe("headless")
    expect(broker.get(session.id)?.runtimeDetails.headless?.execReady).toBe(true)
    expect(events.some((message) => message.includes("genio/runtime/error"))).toBeTrue()
    await broker.stop(session.id)
  })

  test("starts Codex without provisioning a sandbox, then binds one exec runtime on demand", async () => {
    const requests: RuntimeProvisionRequest[] = []
    let closeCount = 0
    const provider: RuntimeProvider = {
      async provision(request) {
        requests.push(request)
        return {
          ...execDesktop("sandbox-1"),
          async close() { closeCount += 1 },
        } satisfies ManagedDesktop
      },
    }
    const broker = new RuntimeBroker(provider)
    const session = await broker.start(principal, { onMessage() {}, onExit() {} })

    expect(requests).toEqual([])
    expect(session.details.execReady).toBe(false)
    expect(broker.latestDetails()?.sandboxId).toBeNull()

    const ready = await broker.ensureExec(session.id)
    expect(ready.details.execReady).toBe(true)
    expect(requests).toEqual([{
      runtimeSessionId: session.id,
      tenantId: "tenant-keycloak-local",
      subjectId: "person-platform-admin",
      actingClientId: "genio-one-bot",
      tier: "headless",
    }])
    expect(broker.latestDetails()?.sandboxId).toBe("sandbox-1")
    await broker.ensureExec(session.id)
    expect(requests).toHaveLength(1)

    await broker.stop(session.id)
    await broker.stop(session.id)
    expect(closeCount).toBe(1)
    expect(broker.activeCount()).toBe(0)
  })

  test("reattaches the same principal without reprovisioning during the disconnect grace", async () => {
    let provisionCount = 0
    let closeCount = 0
    const provider: RuntimeProvider = {
      async provision() {
        provisionCount += 1
        return {
          details: { kind: "e2b-self-hosted", tier: "headless", cwd: "/home/user", desktopUrl: null, sandboxId: "sandbox-stable", environmentId: "e2b-sandbox-stable", execServerUrl: "ws://executor.test", execReady: true },
          async close() { closeCount += 1 },
        }
      },
    }
    const broker = new RuntimeBroker(provider, 1_000)
    const firstCallbacks = { onMessage() {}, onExit() {} }
    const secondCallbacks = { onMessage() {}, onExit() {} }
    const first = await broker.start(principal, firstCallbacks)
    await broker.ensureExec(first.id)

    broker.detach(first.id, firstCallbacks)
    const second = await broker.start(principal, secondCallbacks)

    expect(second.id).toBe(first.id)
    expect(provisionCount).toBe(1)
    expect(closeCount).toBe(0)
    await broker.stop(second.id)
    expect(closeCount).toBe(1)
  })

  test("stops an abandoned runtime after the disconnect grace", async () => {
    let closeCount = 0
    const provider: RuntimeProvider = {
      async provision() {
        return {
          ...execDesktop("sandbox-abandoned"),
          async close() { closeCount += 1 },
        }
      },
    }
    const broker = new RuntimeBroker(provider, 1)
    const callbacks = { onMessage() {}, onExit() {} }
    const session = await broker.start(principal, callbacks)
    await broker.ensureExec(session.id)

    broker.detach(session.id, callbacks)
    await Bun.sleep(10)

    expect(closeCount).toBe(1)
    expect(broker.activeCount()).toBe(0)
  })

  test("coalesces concurrent connections from the same browser principal", async () => {
    let provisionCount = 0
    const provider: RuntimeProvider = {
      async provision() {
        provisionCount += 1
        await Bun.sleep(5)
        return {
          details: { kind: "e2b-self-hosted", tier: "headless", cwd: "/home/user", desktopUrl: null, sandboxId: "sandbox-single", environmentId: "e2b-sandbox-single", execServerUrl: "ws://executor.test", execReady: true },
          async close() {},
        }
      },
    }
    const broker = new RuntimeBroker(provider)
    const [first, second] = await Promise.all([
      broker.start(principal, { onMessage() {}, onExit() {} }),
      broker.start(principal, { onMessage() {}, onExit() {} }),
    ])

    expect(first.id).toBe(second.id)
    expect(provisionCount).toBe(0)
    expect(first.details.execReady).toBe(false)
    expect(broker.activeCount()).toBe(1)
    await broker.stop(first.id)
  })

  test("hosts Codex runtime across disconnect, buffers background messages, and replays on reattach", async () => {
    const provider: RuntimeProvider = {
      async provision() {
        return {
          details: { kind: "local", tier: "none", cwd: "/tmp", desktopUrl: null, sandboxId: null, environmentId: null, execServerUrl: null, execReady: false },
          async close() {},
        }
      },
    }
    const broker = new RuntimeBroker(provider, 1_000)
    let codexCallback: { onMessage(msg: string): void } | null = null
    let codexClosed = false
    const codexFactory = (callbacks: { onMessage(msg: string): void; onExit(reason: string): void }) => {
      codexCallback = callbacks
      return {
        async send() {},
        async close() { codexClosed = true },
      }
    }

    const firstMessages: string[] = []
    const firstCallbacks = {
      onMessage(msg: string) { firstMessages.push(msg) },
      onExit() {},
    }

    const session = await broker.start(principal, firstCallbacks, codexFactory)
    expect(session.codex).toBeDefined()

    // Codex outputs message while connected
    codexCallback!.onMessage('{"method":"item/agentMessage/delta","params":{"delta":"Live"}}')
    expect(firstMessages).toEqual(['{"method":"item/agentMessage/delta","params":{"delta":"Live"}}'])

    // User disconnects
    broker.detach(session.id, firstCallbacks)

    // Codex outputs background message while disconnected
    codexCallback!.onMessage('{"method":"item/agentMessage/delta","params":{"delta":"Background"}}')
    codexCallback!.onMessage('{"method":"turn/completed","params":{"status":"done"}}')
    expect(codexClosed).toBeFalse() // Must NOT be killed!

    // User reconnects
    const secondMessages: string[] = []
    const secondCallbacks = {
      onMessage(msg: string) { secondMessages.push(msg) },
      onExit() {},
    }
    const resumed = await broker.start(principal, secondCallbacks, codexFactory)
    expect(resumed.id).toBe(session.id)
    // Buffered background messages replayed to the new connection
    expect(secondMessages).toEqual([
      '{"method":"item/agentMessage/delta","params":{"delta":"Background"}}',
      '{"method":"turn/completed","params":{"status":"done"}}',
    ])

    await broker.stop(session.id)
    expect(codexClosed).toBeTrue()
  })

  test("automatically evicts the session when the Codex process exits", async () => {
    let codexCallback: { onMessage: (msg: string) => void; onExit: (reason: string) => void } | null = null
    let codexClosed = false
    const codexFactory = (callbacks: { onMessage: (msg: string) => void; onExit: (reason: string) => void }) => {
      codexCallback = callbacks
      return {
        async send() {},
        async close() { codexClosed = true },
      }
    }
    const broker = new RuntimeBroker({ async provision() { return execDesktop("sandbox-test") } })
    let clientExited = false
    const session = await broker.start(principal, {
      onMessage() {},
      onExit() { clientExited = true },
    }, codexFactory)

    expect(broker.get(session.id)).toBeDefined()
    // Process exits unexpectedly
    codexCallback!.onExit("crash")
    expect(clientExited).toBeTrue()
    expect(broker.get(session.id)).toBeNull()

    // Next connection starts a fresh session instead of returning dead one
    const newSession = await broker.start(principal, { onMessage() {}, onExit() {} })
    expect(newSession.id).not.toBe(session.id)
    expect(codexClosed).toBeDefined()
    await broker.stop(newSession.id)
  })
})
