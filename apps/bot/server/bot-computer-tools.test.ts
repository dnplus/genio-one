import { expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { executeComputerTool } from "./bot-computer-tools"
import { BotRegistry } from "./bot-registry"
import { createCapabilityGate } from "./capability-gate"
import { E2BDesktopDriver, type E2BDesktopSdk } from "./desktop-driver"
import type { BotServerContext } from "./context"
import { RuntimeBroker, type GenioPrincipal } from "./runtime-broker"
import type { ManagedDesktop, RuntimeProvisionRequest } from "./runtime"
import type { RuntimePolicyAction, RuntimePolicyDecision, RuntimePolicyResolver } from "./runtime-policy-contract"

const principal: GenioPrincipal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }

function policyDecision(request: { botId: string; capabilityId: string; action: RuntimePolicyAction }, decision: "ALLOW" | "DENY" = "ALLOW"): RuntimePolicyDecision {
  return {
    tenant_id: principal.tenant_id,
    subject_id: principal.subject_id,
    client_id: principal.acting_client_id,
    bot_id: request.botId,
    runtime_id: "codex",
    policy_id: "policy",
    policy_display_name: "Policy",
    policy_revision: 1,
    capability_id: request.capabilityId,
    action: request.action,
    target: `runtime:codex:${request.capabilityId}`,
    decision,
    reason_code: decision === "ALLOW" ? "ALLOWED" : "DENIED",
    constraints: [],
    obligations: [],
    correlation_id: "correlation",
    session_id: "session",
    evaluated_at: 1,
  }
}

function fakeDesktop(): E2BDesktopSdk {
  return {
    async screenshot() { return new Uint8Array([137, 80, 78, 71]) },
    async leftClick() {},
    async doubleClick() {},
    async rightClick() {},
    async write() {},
    async press() {},
    async scroll() {},
    async getScreenSize() { return { width: 1440, height: 900 } },
  }
}

function lease(request: RuntimeProvisionRequest, withComputer = true): ManagedDesktop {
  const details = { kind: "e2b-self-hosted" as const, tier: "desktop" as const, cwd: "/home/user", desktopUrl: "https://desktop", sandboxId: "sandbox", environmentId: "e2b-sandbox", execServerUrl: "ws://executor", execReady: true }
  const computer = withComputer ? new E2BDesktopDriver(fakeDesktop(), { runtimeSessionId: request.runtimeSessionId, tenantId: request.tenantId, subjectId: request.subjectId, actingClientId: request.actingClientId }) : undefined
  return {
    details,
    ...(computer ? { computer } : {}),
    async close() { await computer?.close() },
  }
}

function policy(reports: Array<any>, result: "ALLOW" | "DENY" = "ALLOW"): RuntimePolicyResolver {
  return {
    async resolve() { throw new Error("not used") },
    async read() { throw new Error("not used") },
    async authorize(input) { return policyDecision({ botId: input.botId, capabilityId: input.capabilityId, action: input.action }, result) },
    async report(input) { reports.push(input) },
  }
}

async function fixture(options: { withComputer?: boolean; policyResult?: "ALLOW" | "DENY"; computerEntitled?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "bot-computer-tools-"))
  const registry = new BotRegistry(join(directory, "registry.sqlite"), join(directory, "artifacts"))
  const bot = registry.create(principal, { name: "Computer", description: "Computer Bot" })
  let provisions = 0
  const broker = new RuntimeBroker({ provision: async (request) => { provisions += 1; return lease(request, options.withComputer !== false) } })
  const session = await broker.start(principal, { onMessage() {}, onExit() {} }, undefined, "access-token")
  session.selectedBotId = bot.id
  const reports: Array<any> = []
  const context = {
    botRegistry: registry,
    runtimeBroker: broker,
    capabilityGate: createCapabilityGate({ mode: "fixture", computerUseAllowlist: options.computerEntitled === false ? [] : ["tenant:owner"] }),
    runtimePolicy: policy(reports, options.policyResult),
  } as BotServerContext
  return { directory, registry, broker, bot, session, reports, context, provisions: () => provisions }
}

async function cleanup(value: Awaited<ReturnType<typeof fixture>>) {
  await value.broker.stop(value.session.id)
  value.registry.close()
  rmSync(value.directory, { recursive: true, force: true })
}

test("computer tool returns an E2B screenshot and reports the same governed operation", async () => {
  const value = await fixture()
  try {
    const result = await executeComputerTool("computer_use", { operation: "screenshot" }, { context: value.context, botId: value.bot.id, principal, accessToken: "access-token" })
    expect(result.content[0]).toMatchObject({ type: "image", mimeType: "image/png" })
    expect(result.content[1]).toMatchObject({ type: "text" })
    expect(value.reports).toHaveLength(2)
    expect(value.reports).toContainEqual(expect.objectContaining({ capabilityId: "computer.use", action: "invoke", outcome: "COMPLETED", botId: value.bot.id, sessionId: value.session.id }))
  } finally { await cleanup(value) }
})

test("computer tool fails closed without a managed E2B computer lease", async () => {
  const value = await fixture({ withComputer: false })
  try {
    await expect(executeComputerTool("computer_use", { operation: "screenshot" }, { context: value.context, botId: value.bot.id, principal, accessToken: "access-token" })).rejects.toThrow("E2B_DESKTOP_REQUIRED")
    expect(value.reports).toHaveLength(2)
  } finally { await cleanup(value) }
})

test("computer tool enforces personal gate and canonical runtime policy", async () => {
  const deniedGate = await fixture({ computerEntitled: false })
  try {
    await expect(executeComputerTool("computer_use", { operation: "screenshot" }, { context: deniedGate.context, botId: deniedGate.bot.id, principal, accessToken: "access-token" })).rejects.toThrow("LOCAL_TEST_FIXTURE_DENY")
    expect(deniedGate.reports).toHaveLength(0)
    expect(deniedGate.provisions()).toBe(0)
  } finally { await cleanup(deniedGate) }
  const deniedPolicy = await fixture({ policyResult: "DENY" })
  try {
    await expect(executeComputerTool("computer_use", { operation: "screenshot" }, { context: deniedPolicy.context, botId: deniedPolicy.bot.id, principal, accessToken: "access-token" })).rejects.toThrow("DENIED")
    expect(deniedPolicy.reports[0]).toMatchObject({ outcome: "DENY", capabilityId: "computer.use", action: "expose" })
    expect(deniedPolicy.provisions()).toBe(0)
  } finally { await cleanup(deniedPolicy) }
  const deniedInvoke = await fixture()
  try {
    const runtimePolicy = deniedInvoke.context.runtimePolicy
    deniedInvoke.context.runtimePolicy = {
      ...runtimePolicy,
      async authorize(input) {
        return policyDecision({ botId: input.botId, capabilityId: input.capabilityId, action: input.action }, input.action === "invoke" ? "DENY" : "ALLOW")
      },
    }
    await expect(executeComputerTool("computer_use", { operation: "screenshot" }, { context: deniedInvoke.context, botId: deniedInvoke.bot.id, principal, accessToken: "access-token" })).rejects.toThrow("DENIED")
    expect(deniedInvoke.provisions()).toBe(0)
    expect(deniedInvoke.reports).toContainEqual(expect.objectContaining({ action: "expose", outcome: "ALLOW" }))
    expect(deniedInvoke.reports).toContainEqual(expect.objectContaining({ action: "invoke", outcome: "DENY" }))
  } finally { await cleanup(deniedInvoke) }
})

test("computer tool rejects typing after invoke revocation on an observed desktop", async () => {
  const value = await fixture()
  try {
    const execution = { context: value.context, botId: value.bot.id, principal, accessToken: "access-token" }
    await executeComputerTool("computer_use", { operation: "screenshot" }, execution)
    const computer = value.session.leases.desktop!.computer!
    const execute = spyOn(computer, "execute")
    const runtimePolicy = value.context.runtimePolicy
    value.context.runtimePolicy = {
      ...runtimePolicy,
      async authorize(input) {
        return policyDecision(input, input.action === "invoke" ? "DENY" : "ALLOW")
      },
    }
    await expect(executeComputerTool("computer_use", { operation: "type", text: "denied marker", expectedRevision: 1 }, execution)).rejects.toThrow("DENIED")
    expect(execute).not.toHaveBeenCalled()
    expect(value.provisions()).toBe(1)
    expect(value.reports.slice(-2)).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "expose", outcome: "ALLOW" }),
      expect.objectContaining({ action: "invoke", outcome: "DENY", botId: value.bot.id, sessionId: value.session.id }),
    ]))
    execute.mockRestore()
  } finally { await cleanup(value) }
})

test("computer tool terminates exposure when invoke authorization throws without provisioning a desktop", async () => {
  const value = await fixture()
  try {
    const runtimePolicy = value.context.runtimePolicy
    value.context.runtimePolicy = {
      ...runtimePolicy,
      async authorize(input) {
        if (input.action === "invoke") throw new Error("RUNTIME_POLICY_TRANSPORT_FAILED")
        return runtimePolicy.authorize(input)
      },
    }
    await expect(executeComputerTool("computer_use", { operation: "screenshot" }, { context: value.context, botId: value.bot.id, principal, accessToken: "access-token" })).rejects.toThrow("RUNTIME_POLICY_TRANSPORT_FAILED")
    expect(value.provisions()).toBe(0)
    const report = value.reports.find((item) => item.action === "expose" && item.outcome === "FAILED")
    expect(report).toMatchObject({ botId: value.bot.id, sessionId: value.session.id, capabilityId: "computer.use", reasonCode: "RUNTIME_POLICY_TRANSPORT_FAILED" })
    expect(report.correlationId).toEqual(expect.any(String))
    expect(report.correlationId.length).toBeGreaterThan(0)
    expect(value.reports).not.toContainEqual(expect.objectContaining({ action: "invoke" }))
  } finally { await cleanup(value) }
})

test("computer tool binds shared desktop observations to the Bot that captured them", async () => {
  const value = await fixture()
  try {
    await executeComputerTool("computer_use", { operation: "screenshot" }, { context: value.context, botId: value.bot.id, principal, accessToken: "access-token" })
    const other = value.registry.create(principal, { name: "Other", description: "Other Bot" })
    await expect(executeComputerTool("computer_use", { operation: "click", x: 1, y: 1, expectedRevision: 1 }, { context: value.context, botId: other.id, principal, accessToken: "access-token" })).rejects.toThrow("COMPUTER_OBSERVATION_BOT_MISMATCH")
    await executeComputerTool("computer_use", { operation: "screenshot" }, { context: value.context, botId: other.id, principal, accessToken: "access-token" })
    await expect(executeComputerTool("computer_use", { operation: "click", x: 1, y: 1, expectedRevision: 1 }, { context: value.context, botId: value.bot.id, principal, accessToken: "access-token" })).rejects.toThrow("COMPUTER_OBSERVATION_STALE")
    await expect(executeComputerTool("computer_use", { operation: "click", x: 1, y: 1, expectedRevision: 2 }, { context: value.context, botId: other.id, principal, accessToken: "access-token" })).resolves.toBeDefined()
    const computer = value.session.leases.desktop!.computer!
    await value.broker.stop(value.session.id)
    await expect(computer.execute({ operation: "screenshot" }, { actorBotId: value.bot.id })).rejects.toThrow("COMPUTER_DRIVER_CLOSED")
  } finally {
    value.registry.close()
    rmSync(value.directory, { recursive: true, force: true })
  }
})

test("computer tool continues background Bot work while the UI selects another Bot", async () => {
  const value = await fixture()
  try {
    const other = value.registry.create(principal, { name: "Other", description: "Other Bot" })
    const runtimePolicy = value.context.runtimePolicy
    value.context.runtimePolicy = {
      ...runtimePolicy,
      async authorize(input) {
        const decision = await runtimePolicy.authorize(input)
        if (input.action === "invoke") value.session.selectedBotId = other.id
        return decision
      },
    }
    await expect(executeComputerTool("computer_use", { operation: "screenshot" }, { context: value.context, botId: value.bot.id, principal, accessToken: "access-token" })).resolves.toBeDefined()
    expect(value.reports).toContainEqual(expect.objectContaining({ action: "invoke", outcome: "COMPLETED" }))
  } finally { await cleanup(value) }
})

test("computer tool reports an unconfirmed result when the post-action audit receipt fails", async () => {
  const value = await fixture()
  try {
    const runtimePolicy = value.context.runtimePolicy
    value.context.runtimePolicy = {
      ...runtimePolicy,
      async report(input) {
        if (input.action === "invoke" && input.outcome === "COMPLETED") throw new Error("RUNTIME_POLICY_REPORT_UNAVAILABLE")
        await runtimePolicy.report(input)
      },
    }
    await expect(executeComputerTool("computer_use", { operation: "screenshot" }, { context: value.context, botId: value.bot.id, principal, accessToken: "access-token" })).rejects.toThrow("COMPUTER_RESULT_UNCONFIRMED")
  } finally { await cleanup(value) }
})

test("computer tool reports invoke failure and aborts when the exposure completion receipt fails", async () => {
  const value = await fixture()
  try {
    const runtimePolicy = value.context.runtimePolicy
    value.context.runtimePolicy = {
      ...runtimePolicy,
      async report(input) {
        if (input.action === "expose" && input.outcome === "COMPLETED") throw new Error("RUNTIME_POLICY_REPORT_UNAVAILABLE")
        await runtimePolicy.report(input)
      },
    }
    await expect(executeComputerTool("computer_use", { operation: "screenshot" }, { context: value.context, botId: value.bot.id, principal, accessToken: "access-token" })).rejects.toThrow("COMPUTER_RESULT_UNCONFIRMED")
    expect(value.reports).toContainEqual(expect.objectContaining({ action: "invoke", outcome: "FAILED", reasonCode: "COMPUTER_RESULT_UNCONFIRMED" }))
    expect(value.reports).not.toContainEqual(expect.objectContaining({ action: "invoke", outcome: "COMPLETED" }))
  } finally { await cleanup(value) }
})
