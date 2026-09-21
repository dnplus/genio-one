import { describe, expect, test } from "bun:test"

import { LocalHands } from "./local-hands"

class FakeSocket {
  readonly OPEN = 1
  readyState = this.OPEN
  bufferedAmount = 0
  readonly sent: string[] = []
  private readonly listeners = new Map<string, Array<(...values: unknown[]) => void>>()

  on(event: string, listener: (...values: unknown[]) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
  }

  send(value: unknown) {
    this.sent.push(String(value))
  }

  close() {
    if (this.readyState !== this.OPEN) return
    this.readyState = 3
    this.emit("close")
  }

  ping() {}

  emit(event: string, ...values: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...values)
  }
}

function waitFor(check: () => boolean) {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 1_000
    const tick = () => {
      if (check()) return resolve()
      if (Date.now() >= deadline) return reject(new Error("LOCAL_HANDS_TEST_TIMEOUT"))
      setTimeout(tick, 1)
    }
    tick()
  })
}

function fixture({ failAcceptedReport = false }: { failAcceptedReport?: boolean } = {}) {
  const calls: Array<Record<string, unknown>> = []
  const reports: Array<Record<string, unknown>> = []
  const session = {
    id: "runtime-session",
    principal: {
      tenant_id: "tenant-uat",
      subject_id: "person-dylan",
      acting_client_id: "genio-one-bot",
      scopes: ["genioone-invocation"],
    },
    selectedBotId: "bot-dylan",
    accessToken: "session-token",
    leases: {} as { headless?: unknown },
  }
  const context = {
    botRegistry: {
      getOwned: () => ({ id: "bot-dylan" }),
      timeline: { activeTurns: () => [] },
    },
    capabilityGate: {
      async resolve() { return { decision: "ALLOW" } },
    },
    runtimeBroker: {
      get: () => session,
      attachEndpoint(_id: string, desktop: unknown) {
        if (session.leases.headless) throw new Error("LOCAL_HANDS_RUNTIME_CONFLICT")
        session.leases.headless = desktop
      },
      detachEndpoint(_id: string, desktop: unknown) {
        if (session.leases.headless !== desktop) return false
        delete session.leases.headless
        return true
      },
      notifyEndpoint() {},
    },
    runtimePolicy: {
      async authorize(input: Record<string, unknown>) {
        calls.push(input)
        return {
          tenant_id: "tenant-uat",
          subject_id: "person-dylan",
          client_id: "genio-one-bot",
          bot_id: input.botId,
          runtime_id: "codex",
          policy_id: "one-policy.runtime.capabilities",
          policy_display_name: "Runtime capabilities",
          policy_revision: 1,
          capability_id: input.capabilityId,
          action: input.action,
          target: `runtime:codex:${input.capabilityId}`,
          decision: "ALLOW" as const,
          reason_code: "RULE_ALLOW:runtime",
          constraints: [],
          obligations: [{ kind: "audit", enforcement_point_id: "AGENT_RUNTIME", parameters: {} }],
          correlation_id: input.correlationId,
          session_id: "runtime-session",
          evaluated_at: 1_757_000_000,
        }
      },
      async report(input: Record<string, unknown>) {
        reports.push(input)
        if (failAcceptedReport && input.reasonCode === "REMOTE_HANDS_ENDPOINT_ACCEPTED") {
          failAcceptedReport = false
          throw new Error("RUNTIME_POLICY_REPORT_FAILED")
        }
      },
    },
  }
  return { hands: new LocalHands(context as never), calls, reports, session }
}

describe("local hands runtime policy", () => {
  test("exposes remote hands before pairing and uses it at endpoint acceptance", async () => {
    const { hands, calls, reports, session } = fixture()
    const pairing = await hands.pair(session as never, "bot-dylan")

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ capabilityId: "remote_hands.use", action: "expose" })
    expect(reports[0]).toMatchObject({ capabilityId: "remote_hands.use", action: "expose", outcome: "COMPLETED", reasonCode: "REMOTE_HANDS_PAIRING_EXPOSED" })

    const endpoint = new FakeSocket()
    await hands.accept(endpoint as never, {
      token: pairing.token,
      version: 1,
      executorVersion: pairing.executorVersion,
      cwd: "/workspace",
      hostname: "developer-mac",
    }, 5181)

    expect(calls).toHaveLength(2)
    expect(calls[1]).toMatchObject({ capabilityId: "remote_hands.use", action: "use" })
    expect(reports[1]).toMatchObject({ capabilityId: "remote_hands.use", action: "use", outcome: "COMPLETED", reasonCode: "REMOTE_HANDS_ENDPOINT_ACCEPTED" })
    await hands.close()
  })

  test("rolls back a reported endpoint acceptance failure and accepts a retry", async () => {
    const { hands, session } = fixture({ failAcceptedReport: true })
    const failedPairing = await hands.pair(session as never, "bot-dylan")
    const failedEndpoint = new FakeSocket()

    await expect(hands.accept(failedEndpoint as never, {
      token: failedPairing.token,
      version: 1,
      executorVersion: failedPairing.executorVersion,
      cwd: "/workspace",
      hostname: "developer-mac",
    }, 5181)).rejects.toThrow("RUNTIME_POLICY_REPORT_FAILED")

    expect(failedEndpoint.readyState).toBe(3)
    expect(session.leases.headless).toBeUndefined()

    const retryPairing = await hands.pair(session as never, "bot-dylan")
    const retryEndpoint = new FakeSocket()
    await hands.accept(retryEndpoint as never, {
      token: retryPairing.token,
      version: 1,
      executorVersion: retryPairing.executorVersion,
      cwd: "/workspace",
      hostname: "developer-mac",
    }, 5181)

    expect(retryEndpoint.readyState).toBe(retryEndpoint.OPEN)
    expect(session.leases.headless).toBeDefined()
    await hands.close()
  })

  test("does not detach an unrelated headless lease after an endpoint runtime conflict", async () => {
    const { hands, session } = fixture()
    const pairing = await hands.pair(session as never, "bot-dylan")
    const existingLease = {}
    session.leases.headless = existingLease
    const endpoint = new FakeSocket()

    await expect(hands.accept(endpoint as never, {
      token: pairing.token,
      version: 1,
      executorVersion: pairing.executorVersion,
      cwd: "/workspace",
      hostname: "developer-mac",
    }, 5181)).rejects.toThrow("LOCAL_HANDS_RUNTIME_CONFLICT")

    expect(endpoint.readyState).toBe(3)
    expect(session.leases.headless).toBe(existingLease)
    await hands.close()
  })

  test("uses the registry action for every local shell and filesystem operation", async () => {
    const { hands, calls, session } = fixture()
    const pairing = await hands.pair(session as never, "bot-dylan")
    const endpoint = new FakeSocket()
    await hands.accept(endpoint as never, {
      token: pairing.token,
      version: 1,
      executorVersion: pairing.executorVersion,
      cwd: "/workspace",
      hostname: "developer-mac",
    }, 5181)
    const ready = JSON.parse(endpoint.sent[0]!) as { endpointId: string }
    const executorUrl = new URL(hands.executorUrl(ready.endpointId))
    const consumer = new FakeSocket()
    hands.attachConsumer(ready.endpointId, executorUrl.searchParams.get("token"), consumer as never)

    consumer.emit("message", JSON.stringify({ id: 1, method: "process/start", params: { processId: "process-1" } }))
    await waitFor(() => calls.length === 3)
    expect(calls[2]).toMatchObject({ capabilityId: "shell.exec", action: "execute" })

    consumer.emit("message", JSON.stringify({ id: 2, method: "fs/readFile", params: { path: "/workspace/readme.md" } }))
    await waitFor(() => calls.length === 4)
    expect(calls[3]).toMatchObject({ capabilityId: "filesystem.read", action: "invoke" })
    await hands.close()
  })
})
