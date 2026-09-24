import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { managedMcpMountsForBot, RuntimeBroker, setBotSelection, type GenioPrincipal, type RuntimeProvider } from "./runtime-broker"
import { handsMcpGrantFor } from "./hands-mcp-grant"
import type { ManagedDesktop, RuntimeProvisionRequest, RuntimeCallbacks } from "./runtime"
import { BotRegistry } from "./bot-registry"
import { BotWorkspaceStore } from "./bot-workspace-store"

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
  test("Cloudflare lease retry identity survives broker restart and remote revision drift, rotates on LOST, and changes after release", async () => {
    const root = mkdtempSync(join(tmpdir(), "genio-hands-lease-retry-"))
    const databasePath = join(root, "bots.sqlite")
    const artifactRoot = join(root, "artifacts")
    const workspaceRoot = join(root, "workspaces")
    const registries: BotRegistry[] = []
    const requests: string[] = []
    let store!: BotWorkspaceStore
    let remoteKey: string | null = null
    let remoteRevision = 0
    let remoteLost = false
    let loseFirstResponse = true
    let loseRotatedResponse = true
    let loseAheadResponse = false
    const provider: RuntimeProvider = {
      async provision(request) {
        const requestKey = request.leaseRequestId!
        requests.push(requestKey)
        if (remoteKey && remoteLost && remoteKey === requestKey) throw new Error("HANDS_LEASE_LOST")
        if (remoteKey && !remoteLost && remoteKey !== requestKey) throw new Error("HANDS_LEASE_BUSY")
        if (loseAheadResponse) {
          loseAheadResponse = false
          store.updateRevision(request.workspace!.workspaceId, remoteRevision)
          throw new TypeError("CF_AHEAD_RESPONSE_LOST")
        }
        const recoveringLostLease = remoteLost
        remoteKey = requestKey
        remoteLost = false
        if (loseFirstResponse) { loseFirstResponse = false; throw new TypeError("CF_RESPONSE_LOST") }
        if (loseRotatedResponse && recoveringLostLease) { loseRotatedResponse = false; throw new TypeError("CF_ROTATED_RESPONSE_LOST") }
        return {
          details: {
            kind: "cloudflare-hands",
            tier: request.tier,
            cwd: "/workspace",
            desktopUrl: null,
            sandboxId: null,
            environmentId: `hands-${requestKey}`,
            execServerUrl: "ws://executor.test",
            execReady: true,
            botId: request.botId,
            workspaceId: request.workspace?.workspaceId,
            leaseId: requestKey,
          },
          async close() {
            if (remoteKey !== requestKey) return
            remoteKey = null
            remoteRevision += 1
            store.updateRevision(request.workspace!.workspaceId, remoteRevision)
          },
        }
      },
    }
    const open = async () => {
      const registry = new BotRegistry(databasePath, artifactRoot)
      registries.push(registry)
      store = new BotWorkspaceStore(registry.db, (botId, actor) => registry.getOwned(botId, actor), workspaceRoot)
      const broker = new RuntimeBroker(provider, 600_000, store)
      const session = await broker.start(principal, { onMessage() {}, onExit() {} })
      return { registry, broker, session }
    }
    try {
      const first = await open()
      const bot = first.registry.create(principal, { name: "Cloud lease", description: "Durable retry" })
      store.create(principal, bot.id, "cloudflare-hands")
      const otherClient = { ...principal, acting_client_id: "other-bot-client" }
      await expect(first.broker.ensure(first.session.id, "headless", bot.id)).rejects.toThrow("CF_RESPONSE_LOST")
      expect(store.unresolvedLeaseAttempt(principal, first.session.id)?.botId).toBe(bot.id)
      expect(store.unresolvedLeaseAttempt(principal, "another-session")).toBeNull()
      expect(store.unresolvedLeaseAttempt({ ...principal, acting_client_id: "another-client" }, first.session.id)).toBeNull()
      const otherPendingSession = await first.broker.start(otherClient, { onMessage() {}, onExit() {} })
      await expect(first.broker.ensure(otherPendingSession.id, "headless", bot.id)).rejects.toThrow("WORKSPACE_BUSY")
      expect(requests).toHaveLength(1)
      await expect(first.broker.ensure(first.session.id, "desktop", bot.id)).rejects.toThrow("WORKSPACE_BUSY")
      await expect(first.broker.stop(first.session.id, "headless")).rejects.toThrow("HANDS_PROVISION_UNCONFIRMED")
      await first.broker.close()
      first.registry.close()

      const second = await open()
      await second.broker.ensure(second.session.id, "headless", bot.id)
      expect(second.session.id).not.toBe(first.session.id)
      expect(requests[1]).toBe(requests[0])
      const otherReadySession = await second.broker.start(otherClient, { onMessage() {}, onExit() {} })
      await expect(second.broker.ensure(otherReadySession.id, "headless", bot.id)).rejects.toThrow("WORKSPACE_BUSY")
      expect(requests).toHaveLength(2)
      await second.broker.stop(second.session.id, "headless")
      expect(store.active(principal, bot.id)?.revision).toBe(1)
      await second.broker.ensure(second.session.id, "headless", bot.id)
      expect(requests[2]).not.toBe(requests[0])
      remoteRevision = 2
      loseAheadResponse = true
      second.registry.close()

      const third = await open()
      await expect(third.broker.ensure(third.session.id, "headless", bot.id)).rejects.toThrow("CF_AHEAD_RESPONSE_LOST")
      expect(requests[3]).toBe(requests[2])
      expect(store.active(principal, bot.id)?.revision).toBe(2)
      third.registry.close()

      const fourth = await open()
      await fourth.broker.ensure(fourth.session.id, "headless", bot.id)
      expect(requests[4]).toBe(requests[3])
      remoteLost = true
      fourth.registry.close()

      const fifth = await open()
      await expect(fifth.broker.ensure(fifth.session.id, "headless", bot.id)).rejects.toThrow("HANDS_LEASE_LOST")
      expect(requests[5]).toBe(requests[4])
      fifth.registry.close()

      const sixth = await open()
      await expect(sixth.broker.ensure(sixth.session.id, "headless", bot.id)).rejects.toThrow("CF_ROTATED_RESPONSE_LOST")
      expect(requests[6]).not.toBe(requests[5])
      sixth.registry.close()

      const seventh = await open()
      await seventh.broker.ensure(seventh.session.id, "headless", bot.id)
      expect(requests[7]).toBe(requests[6])
      await seventh.broker.stop(seventh.session.id, "headless")
      expect(store.active(principal, bot.id)?.revision).toBe(3)
      await seventh.broker.ensure(seventh.session.id, "headless", bot.id)
      expect(requests[8]).not.toBe(requests[7])
      await seventh.broker.stop(seventh.session.id)
      const releasedWorkspace = store.active(otherClient, bot.id)!
      const nextClientKey = store.reserveLeaseAttempt(releasedWorkspace, "headless", "other-session", otherClient.acting_client_id)
      expect(nextClientKey).not.toBe(requests[8])
      seventh.registry.close()
    } finally {
      for (const registry of registries) { try { registry.close() } catch {} }
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("keeps delegated invocation credentials bound to each Bot while owner OAuth rotates", async () => {
    const broker = new RuntimeBroker({ provision: async () => execDesktop("invocation-credentials") })
    const session = await broker.start(principal, { onMessage() {}, onExit() {} }, undefined, "owner-token-a")
    const releaseA = broker.bindInvocationAccessToken(session.id, "bot-a", "invocation-a", "agent-token-a")
    const releaseB = broker.bindInvocationAccessToken(session.id, "bot-b", "invocation-b", "agent-token-b")

    expect(broker.accessTokenForBot(session.id, "bot-a")).toBe("agent-token-a")
    expect(broker.accessTokenForBot(session.id, "bot-b")).toBe("agent-token-b")
    expect(() => broker.bindInvocationAccessToken(session.id, "bot-a", "invocation-next", "agent-token-next")).toThrow("RUNTIME_INVOCATION_ACCESS_TOKEN_CONFLICT")

    await broker.start(principal, { onMessage() {}, onExit() {} }, undefined, "owner-token-b")
    expect(session.accessToken).toBe("owner-token-b")
    expect(broker.accessTokenForBot(session.id, "bot-a")).toBe("agent-token-a")
    expect(broker.accessTokenForBot(session.id, "bot-b")).toBe("agent-token-b")

    releaseA()
    expect(broker.accessTokenForBot(session.id, "bot-a")).toBe("owner-token-b")
    expect(broker.accessTokenForBot(session.id, "bot-b")).toBe("agent-token-b")
    const releaseNext = broker.bindInvocationAccessToken(session.id, "bot-a", "invocation-next", "agent-token-next")
    releaseA()
    expect(broker.accessTokenForBot(session.id, "bot-a")).toBe("agent-token-next")

    releaseNext()
    releaseB()
    await broker.stop(session.id)
  })

  test("lists only initialized sessions that retain an access token", async () => {
    const broker = new RuntimeBroker({ provision: async () => execDesktop("claim-targets") })
    const ready = await broker.start(principal, { onMessage() {}, onExit() {} }, undefined, "owner-token")
    ready.initialized = true
    const initializingPrincipal = { ...principal, subject_id: "initializing-owner" }
    await broker.start(initializingPrincipal, { onMessage() {}, onExit() {} }, undefined, "initializing-token")
    const tokenlessPrincipal = { ...principal, subject_id: "tokenless-owner" }
    const tokenless = await broker.start(tokenlessPrincipal, { onMessage() {}, onExit() {} })
    tokenless.initialized = true

    expect(broker.activeSessionPrincipals()).toEqual([principal])
    await broker.close()
  })

  test("keeps managed MCP mounts scoped to the Bot that created them", async () => {
    const broker = new RuntimeBroker({ provision: async () => execDesktop("bot-mounts") })
    const session = await broker.start(principal, { onMessage() {}, onExit() {} })
    const aMounts = {
      "resource-a": { resourceId: "resource-a", capabilityId: "mcp.a", serverName: "genio_mcp_a", hostname: "a.example", basePath: "/mcp" },
    }
    const bMounts = {
      "resource-b": { resourceId: "resource-b", capabilityId: "mcp.b", serverName: "genio_mcp_b", hostname: "b.example", basePath: "/mcp" },
    }

    setBotSelection(session, { botId: "bot-a", usageContext: { consumerOrganizationId: "org-a", useCaseId: "purpose-a" }, mcpMounts: aMounts })
    setBotSelection(session, { botId: "bot-b", usageContext: { consumerOrganizationId: "org-b", useCaseId: "purpose-b" }, mcpMounts: bMounts })
    setBotSelection(session, null)

    expect(session.selectedBotId).toBeNull()
    expect(managedMcpMountsForBot(session, "bot-a")).toEqual(aMounts)
    expect(managedMcpMountsForBot(session, "bot-b")).toEqual(bMounts)
    await broker.stop(session.id)
  })

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
  test("keeps another Bot lease running until it is explicitly released", async () => {
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
    await expect(broker.ensure(session.id, "desktop", "bot-b")).rejects.toThrow("WORKSPACE_BUSY")
    expect(broker.get(session.id)?.runtimeDetails.headless?.execReady).toBe(true)
    await broker.stop(session.id, "headless")
    await broker.ensure(session.id, "desktop", "bot-b")
    expect(requests.map((request) => [request.tier, request.botId])).toEqual([["headless", "bot-a"], ["desktop", "bot-b"]])
    expect(broker.get(session.id)?.runtimeDetails.headless).toBeUndefined()
    expect(broker.get(session.id)?.runtimeDetails.desktop?.desktopUrl).toBe("https://desktop.test")
    await broker.stop(session.id)
  })

  test("detaches only the endpoint lease it attached", async () => {
    const broker = new RuntimeBroker({ provision: async () => execDesktop("endpoint") })
    const session = await broker.start(principal, { onMessage() {}, onExit() {} })
    const first = execDesktop("endpoint-first")
    const second = execDesktop("endpoint-second")

    broker.attachEndpoint(session.id, first)
    expect(broker.detachEndpoint(session.id, first)).toBe(true)
    expect(broker.get(session.id)?.leases.headless).toBeUndefined()
    expect(broker.get(session.id)?.runtimeDetails.headless).toBeUndefined()
    expect(broker.get(session.id)?.details.tier).toBe("none")

    broker.attachEndpoint(session.id, second)
    expect(broker.detachEndpoint(session.id, first)).toBe(false)
    expect(broker.get(session.id)?.leases.headless).toBe(second)
    await broker.stop(session.id)
  })

  test("requires an explicit tier release and clears a failed desktop lease", async () => {
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
    await expect(broker.ensure(session.id, "desktop")).rejects.toThrow("WORKSPACE_BUSY")
    await broker.stop(session.id, "headless")
    await broker.ensure(session.id, "desktop")
    desktopExit!("desktop stopped")
    await Bun.sleep(0)
    expect(broker.get(session.id)?.details.tier).toBe("none")
    expect(broker.get(session.id)?.runtimeDetails.headless).toBeUndefined()
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
      leaseRequestId: expect.any(String),
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
    await Bun.sleep(0)
    expect(broker.get(session.id)).toBeNull()

    // Next connection starts a fresh session instead of returning dead one
    const newSession = await broker.start(principal, { onMessage() {}, onExit() {} })
    expect(newSession.id).not.toBe(session.id)
    expect(codexClosed).toBeDefined()
    await broker.stop(newSession.id)
  })
})

describe("hands MCP grant lifecycle", () => {
  const mounts = { "resource-mail2000": { resourceId: "resource-mail2000", capabilityId: "mail2000", serverName: "genio_mcp_mail2000", hostname: "mail2000.example", basePath: "/mcp" } }

  async function provisioned(relayOrigin: string | undefined) {
    const original = process.env.GENIO_BOT_HANDS_RELAY_ORIGIN
    if (relayOrigin) process.env.GENIO_BOT_HANDS_RELAY_ORIGIN = relayOrigin
    else delete process.env.GENIO_BOT_HANDS_RELAY_ORIGIN
    try {
      const requests: RuntimeProvisionRequest[] = []
      const assetLookups: string[] = []
      const broker = new RuntimeBroker({ async provision(request) { requests.push(request); return execDesktop("hands") } }, undefined, undefined, undefined, {
        handsAssets: (_principal, botId) => { assetLookups.push(botId); return [{ path: "mail2000/bin/m2k.mjs", content: new TextEncoder().encode("cli").buffer }] },
      })
      const session = await broker.start(principal, { onMessage() {}, onExit() {} }, undefined, "owner-token")
      setBotSelection(session, { botId: "bot-mail", usageContext: null, mcpMounts: mounts })
      await broker.ensureExec(session.id, "bot-mail")
      return { broker, session, request: requests[0]!, assetLookups }
    } finally {
      if (original === undefined) delete process.env.GENIO_BOT_HANDS_RELAY_ORIGIN
      else process.env.GENIO_BOT_HANDS_RELAY_ORIGIN = original
    }
  }

  test("issues no sandbox grant unless a sandbox-reachable relay origin is configured", async () => {
    const { broker, session, request, assetLookups } = await provisioned(undefined)

    expect(request.handsMcp).toBeUndefined()
    expect(assetLookups).toEqual([])
    expect(request.handsAssets).toBeUndefined()
    expect(session.handsMcpGrants?.size ?? 0).toBe(0)
    await broker.stop(session.id)
  })

  test("hands the provider a grant for the Bot's mounts and revokes it when the lease stops", async () => {
    const { broker, session, request } = await provisioned("https://bot.internal:5181")

    expect(request.handsMcp).toMatchObject({ relayOrigin: "https://bot.internal:5181", botId: "bot-mail", mounts })
    expect(request.handsAssets?.map((asset) => ({ ...asset, content: Buffer.from(asset.content).toString() }))).toEqual([{ path: "mail2000/bin/m2k.mjs", content: "cli" }])
    expect(session.handsMcpGrants?.size).toBe(1)
    await broker.stop(session.id, "headless")
    expect(session.handsMcpGrants?.size).toBe(0)
    await broker.stop(session.id)
  })

  test("reprovisions a hands lease when the selected Bot changes", async () => {
    const original = process.env.GENIO_BOT_HANDS_RELAY_ORIGIN
    process.env.GENIO_BOT_HANDS_RELAY_ORIGIN = "https://bot.internal:5181"
    const requests: RuntimeProvisionRequest[] = []
    const closed: string[] = []
    const exits: Array<(reason: string) => void> = []
    const broker = new RuntimeBroker({
      async provision(request, callbacks) {
        requests.push(request)
        exits.push(callbacks.onExit)
        const desktop = execDesktop(`hands-${request.botId}`)
        desktop.details.botId = request.botId ?? null
        return { ...desktop, async close() { closed.push(request.botId ?? "") } }
      },
    })
    try {
      const session = await broker.start(principal, { onMessage() {}, onExit() {} }, undefined, "owner-token")
      setBotSelection(session, { botId: "bot-a", usageContext: null, mcpMounts: mounts })
      await broker.ensureExec(session.id, "bot-a")
      const firstGrant = requests[0]!.handsMcp!.token

      setBotSelection(session, { botId: "bot-b", usageContext: null, mcpMounts: mounts })
      await broker.ensureExec(session.id, "bot-b")

      expect(requests.map((request) => request.botId)).toEqual(["bot-a", "bot-b"])
      expect(closed).toEqual(["bot-a"])
      expect(requests[1]!.handsMcp).toMatchObject({ botId: "bot-b", mounts })
      expect(handsMcpGrantFor(session, `Bearer ${firstGrant}`)).toBeNull()
      exits[0]!("old lease exited")
      expect(session.leases.headless?.details.sandboxId).toBe("hands-bot-b")
      expect(handsMcpGrantFor(session, `Bearer ${requests[1]!.handsMcp!.token}`)?.botId).toBe("bot-b")
      await broker.stop(session.id)
    } finally {
      if (original === undefined) delete process.env.GENIO_BOT_HANDS_RELAY_ORIGIN
      else process.env.GENIO_BOT_HANDS_RELAY_ORIGIN = original
    }
  })

  test("coalesces concurrent Bot switches around one old lease close", async () => {
    const original = process.env.GENIO_BOT_HANDS_RELAY_ORIGIN
    process.env.GENIO_BOT_HANDS_RELAY_ORIGIN = "https://bot.internal:5181"
    const requests: RuntimeProvisionRequest[] = []
    const closed: string[] = []
    let releaseClose!: () => void
    let closeStarted!: () => void
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve })
    const closing = new Promise<void>((resolve) => { closeStarted = resolve })
    const broker = new RuntimeBroker({
      async provision(request) {
        requests.push(request)
        const desktop = execDesktop(`hands-${request.botId}`)
        desktop.details.botId = request.botId ?? null
        return {
          ...desktop,
          async close() {
            closed.push(request.botId ?? "")
            if (request.botId === "bot-a") {
              closeStarted()
              await closeGate
            }
          },
        }
      },
    })
    try {
      const session = await broker.start(principal, { onMessage() {}, onExit() {} }, undefined, "owner-token")
      setBotSelection(session, { botId: "bot-a", usageContext: null, mcpMounts: mounts })
      await broker.ensureExec(session.id, "bot-a")
      setBotSelection(session, { botId: "bot-b", usageContext: null, mcpMounts: mounts })

      const first = broker.ensureExec(session.id, "bot-b")
      await closing
      const second = broker.ensureExec(session.id, "bot-b")
      await Promise.resolve()
      expect(requests.map((request) => request.botId)).toEqual(["bot-a"])
      releaseClose()
      await Promise.all([first, second])

      expect(closed).toEqual(["bot-a"])
      expect(requests.map((request) => request.botId)).toEqual(["bot-a", "bot-b"])
      expect(session.leases.headless?.details.botId).toBe("bot-b")
      await broker.stop(session.id)
    } finally {
      releaseClose?.()
      if (original === undefined) delete process.env.GENIO_BOT_HANDS_RELAY_ORIGIN
      else process.env.GENIO_BOT_HANDS_RELAY_ORIGIN = original
    }
  })
})
