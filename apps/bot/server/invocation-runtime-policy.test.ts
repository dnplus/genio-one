import { expect, test } from "bun:test"
import { getEventListeners } from "node:events"

import { BotRegistry } from "./bot-registry"
import { BotToolSessions } from "./bot-tool-sessions"
import type { BotServerContext } from "./context"
import { createInvocationRuntimePolicy } from "./invocation-runtime-policy.test-support"
import { RuntimeBroker } from "./runtime-broker"
import type { RuntimeCallbacks } from "./runtime"
import { runApprovedBotInvocation } from "./routes/invocations"

function scenario(
  modelRoute: "codex-subscription" | "genio-gateway",
  runtimePolicy: BotServerContext["runtimePolicy"],
  options: { explicitCapabilityId?: string; nativeOutcome?: "COMPLETED" | "ERROR" | "ABORT" | "IDLE"; onNativeMethod?: (method: string) => void } = {},
) {
  const registry = new BotRegistry(":memory:")
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  const caller = registry.create(principal, { name: "Caller", description: "Origin" })
  const target = registry.create(principal, {
    name: "Target",
    description: "Recipient",
    modelRoute,
    ...(options.explicitCapabilityId ? { bindings: [{ resourceId: "case-resource", capabilityId: options.explicitCapabilityId, kind: "MCP" as const }] } : {}),
  })
  let invocationId: string
  if (options.explicitCapabilityId) {
    registry.update(target.id, principal, { sharePolicy: { visibility: "ORG", discoverable: true, invocable: true, approval: "POLICY_AUTO_APPROVE", audienceIds: [] } })
    invocationId = registry.createInvocation(principal, {
      callerBotId: caller.id,
      targetBotId: target.id,
      task: "Handle the task",
      requestedCapabilityIds: [options.explicitCapabilityId],
      actionDigest: "case-read",
    }).requestId
  } else {
    invocationId = registry.createHandoffs(principal, { fromBotId: caller.id, toBotId: target.id, fact: "Handle the task" })[0]!.invocationId
  }
  const broker = new RuntimeBroker({ provision: async () => { throw new Error("NOT_USED") } })
  const nativeMethods: string[] = []
  let nativeSpawns = 0
  const context = {
    botRegistry: registry,
    runtimeBroker: broker,
    runtimePolicy,
    botToolSessions: new BotToolSessions(),
    modelDirectory: {
      availableRoutes: () => [modelRoute],
      supports: () => true,
      resolve: async () => [{ publicModelId: "company-model", displayName: "Company Model", route: { kind: "genio-gateway", modelProvider: "genio_one" } }],
    },
    createCodexRuntime: (_token: string, callbacks: RuntimeCallbacks) => {
      nativeSpawns += 1
      return {
        async send(line: string) {
          const request = JSON.parse(line)
          nativeMethods.push(request.method)
          options.onNativeMethod?.(request.method)
          if (request.method === "initialize") callbacks.onMessage(JSON.stringify({ id: request.id, result: {} }))
          if (request.method === "model/list") callbacks.onMessage(JSON.stringify({ id: request.id, result: { data: [{ id: "codex-model", model: "gpt-6-astra", hidden: false, isDefault: true }], nextCursor: null } }))
          if (request.method === "thread/start") callbacks.onMessage(JSON.stringify(options.nativeOutcome === "ERROR"
            ? { id: request.id, error: { code: -32000, message: "native failed" } }
            : { id: request.id, result: { thread: { id: "target-thread" } } }))
          if (request.method === "turn/start") {
            callbacks.onMessage(JSON.stringify({ id: request.id, result: { turn: { id: "target-turn" } } }))
            if (options.nativeOutcome === "ABORT") callbacks.onExit("native interrupted")
            else if (options.nativeOutcome !== "IDLE") callbacks.onMessage(JSON.stringify({ method: "turn/completed", params: { threadId: "target-thread", turn: { id: "target-turn", status: "completed", items: [{ type: "agentMessage", text: "Done" }] } } }))
          }
        },
        async close() {},
      }
    },
  } as unknown as BotServerContext
  return {
    invocationId,
    target,
    broker,
    principal,
    nativeMethods,
    nativeSpawns: () => nativeSpawns,
    run: () => runApprovedBotInvocation(context, invocationId, "owner-token"),
    invocation: () => registry.getInvocationForService(invocationId),
    close: async () => { await broker.close(); registry.close() },
  }
}

test.each(["codex-subscription", "genio-gateway"] as const)("empty-capability %s handoff authorizes and reports its target model operation", async (modelRoute) => {
  const policy = createInvocationRuntimePolicy()
  const authorizations: Parameters<typeof policy.authorize>[0][] = []
  const reports: Parameters<typeof policy.report>[0][] = []
  const authorize = policy.authorize
  policy.authorize = async (input) => { authorizations.push(input); return authorize(input) }
  policy.report = async (input) => { reports.push(input) }
  const handoff = scenario(modelRoute, policy)
  try {
    expect(handoff.invocation()?.requestedCapabilityIds).toEqual([])
    await handoff.run()
    const capabilityId = modelRoute === "genio-gateway" ? "model.invoke" : "codex.subscription"
    const action = modelRoute === "genio-gateway" ? "invoke" : "use"
    expect(authorizations).toHaveLength(1)
    expect(authorizations[0]).toMatchObject({
      principal: { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot" },
      botId: handoff.target.id,
      runtimeId: "codex",
      capabilityId,
      action,
      accessToken: "owner-token",
    })
    expect(authorizations[0]?.sessionId).toBeTruthy()
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      principal: authorizations[0]?.principal,
      botId: handoff.target.id,
      runtimeId: "codex",
      capabilityId,
      action,
      sessionId: authorizations[0]?.sessionId,
      outcome: "COMPLETED",
    })
    expect(reports[0]?.correlationId).toBeTruthy()
    expect(handoff.nativeSpawns()).toBe(1)
    expect(handoff.nativeMethods).toContain("turn/start")
    expect(handoff.invocation()?.state).toBe("COMPLETED")
  } finally { await handoff.close() }
})

test("an explicit requested capability keeps its catalog check and the target model policy report", async () => {
  const originalFetch = globalThis.fetch
  const originalOrigin = process.env.GENIO_ONE_PLATFORM_ORIGIN
  const originalServiceToken = process.env.GENIO_ONE_AGENT_SUBJECT_SERVICE_TOKEN
  process.env.GENIO_ONE_PLATFORM_ORIGIN = "https://platform.example"
  process.env.GENIO_ONE_AGENT_SUBJECT_SERVICE_TOKEN = ""
  const catalogRequests: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith("/v1/identity/session")) return Response.json({ tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] })
    if (url.endsWith("/v1/tenants/tenant/catalog")) {
      catalogRequests.push(url)
      return Response.json({ capabilities: [{ capability_id: "servicenow.csm.read_case", access: "ENTITLED", connection_status: "READY", hub_status: "CONNECTED" }] })
    }
    if (url.endsWith("/v1/tenants/tenant/memory/mcp")) return Response.json({ jsonrpc: "2.0", id: 1, result: { structuredContent: { memories: [], context: "" } } })
    throw new Error(`Unexpected fetch: ${url}`)
  }) as typeof fetch
  const policy = createInvocationRuntimePolicy()
  const authorizations: Parameters<typeof policy.authorize>[0][] = []
  const reports: Parameters<typeof policy.report>[0][] = []
  const authorize = policy.authorize
  policy.authorize = async (input) => { authorizations.push(input); return authorize(input) }
  policy.report = async (input) => { reports.push(input) }
  const handoff = scenario("codex-subscription", policy, { explicitCapabilityId: "servicenow.csm.read_case" })
  try {
    expect(handoff.invocation()?.requestedCapabilityIds).toEqual(["servicenow.csm.read_case"])
    await handoff.run()
    expect(catalogRequests).toHaveLength(1)
    expect(authorizations.map(({ capabilityId, action }) => [capabilityId, action])).toEqual([["codex.subscription", "use"]])
    expect(reports).toMatchObject([{ capabilityId: "codex.subscription", action: "use", outcome: "COMPLETED" }])
    expect(handoff.nativeMethods).toContain("turn/start")
    expect(handoff.invocation()?.state).toBe("COMPLETED")
  } finally {
    await handoff.close()
    globalThis.fetch = originalFetch
    if (originalOrigin === undefined) delete process.env.GENIO_ONE_PLATFORM_ORIGIN
    else process.env.GENIO_ONE_PLATFORM_ORIGIN = originalOrigin
    if (originalServiceToken === undefined) delete process.env.GENIO_ONE_AGENT_SUBJECT_SERVICE_TOKEN
    else process.env.GENIO_ONE_AGENT_SUBJECT_SERVICE_TOKEN = originalServiceToken
  }
})

test.each(["ERROR", "ABORT"] as const)("native %s sends a failed policy outcome", async (nativeOutcome) => {
  const policy = createInvocationRuntimePolicy()
  const reports: Parameters<typeof policy.report>[0][] = []
  policy.report = async (input) => { reports.push(input) }
  const handoff = scenario("codex-subscription", policy, { nativeOutcome })
  try {
    await handoff.run()
    expect(reports).toMatchObject([{ capabilityId: "codex.subscription", action: "use", outcome: "FAILED", reasonCode: nativeOutcome === "ERROR" ? "TARGET_REQUEST_FAILED" : "TARGET_RUNTIME_INTERRUPTED" }])
    expect(handoff.invocation()?.state).toBe("FAILED")
  } finally { await handoff.close() }
})

test.each(["DENY", "UNAVAILABLE", "MISSING_CORRELATION", "MISSING_SESSION", "MISMATCHED_SESSION"] as const)("ordinary handoff fails closed before native runtime creation when policy is %s", async (policyResult) => {
  const policy = createInvocationRuntimePolicy()
  const reports: Parameters<typeof policy.report>[0][] = []
  const authorize = policy.authorize
  policy.authorize = async (input) => {
    if (policyResult === "UNAVAILABLE") throw new Error("RUNTIME_POLICY_UNAVAILABLE")
    const decision = await authorize(input)
    if (policyResult === "DENY") return { ...decision, decision: "DENY", reason_code: "RULE_DENY:runtime" }
    if (policyResult === "MISSING_SESSION") return { ...decision, session_id: null }
    if (policyResult === "MISMATCHED_SESSION") return { ...decision, session_id: "other-session" }
    return { ...decision, correlation_id: null }
  }
  policy.report = async (input) => { reports.push(input) }
  const handoff = scenario("codex-subscription", policy)
  try {
    await handoff.run()
    expect(handoff.invocation()?.state).toBe("DENIED")
    expect(handoff.nativeSpawns()).toBe(0)
    expect(handoff.nativeMethods).toEqual([])
    expect(reports.map((report) => report.outcome)).toEqual(policyResult === "DENY" ? ["DENY"] : [])
  } finally { await handoff.close() }
})

test.each(["DENY", "UNAVAILABLE"] as const)("policy %s removes its broker-close listener after settling", async (policyResult) => {
  const policy = createInvocationRuntimePolicy()
  const authorize = policy.authorize
  policy.authorize = async (input) => {
    if (policyResult === "UNAVAILABLE") throw new Error("RUNTIME_POLICY_UNAVAILABLE")
    return { ...await authorize(input), decision: "DENY", reason_code: "RULE_DENY:runtime" }
  }
  const handoff = scenario("codex-subscription", policy)
  const runTask = handoff.broker.runInvocationTask.bind(handoff.broker)
  let invocationSignal: AbortSignal | undefined
  handoff.broker.runInvocationTask = (task) => runTask((signal) => {
    invocationSignal = signal
    return task(signal)
  })
  try {
    await handoff.run()
    expect(handoff.invocation()?.state).toBe("DENIED")
    expect(invocationSignal).toBeDefined()
    expect(getEventListeners(invocationSignal!, "abort")).toHaveLength(0)
  } finally { await handoff.close() }
})

test("denied handoff does not update an existing native runtime token", async () => {
  const policy = createInvocationRuntimePolicy()
  const authorize = policy.authorize
  policy.authorize = async (input) => ({ ...await authorize(input), decision: "DENY", reason_code: "RULE_DENY:runtime" })
  const handoff = scenario("codex-subscription", policy)
  const nativeTokenUpdates: string[] = []
  try {
    await handoff.broker.start(handoff.principal, { onMessage() {}, onExit() {} }, () => ({
      async send() { throw new Error("UNEXPECTED_NATIVE_CALL") },
      async updateToken(token: string) { nativeTokenUpdates.push(token) },
      async close() {},
    }), "previous-token")
    await handoff.run()
    expect(handoff.invocation()?.state).toBe("DENIED")
    expect(nativeTokenUpdates).toEqual([])
    expect(handoff.nativeSpawns()).toBe(0)
    expect(handoff.nativeMethods).toEqual([])
  } finally { await handoff.close() }
})

test.each([false, true])("handoff does not use a replacement session created during policy authorization (native: %s)", async (replacementHasNative) => {
  const policy = createInvocationRuntimePolicy()
  const authorize = policy.authorize
  const reports: Parameters<typeof policy.report>[0][] = []
  let authorizationStarted!: (sessionId: string) => void
  const started = new Promise<string>((resolve) => { authorizationStarted = resolve })
  let releaseAuthorization!: () => void
  const authorizationGate = new Promise<void>((resolve) => { releaseAuthorization = resolve })
  policy.authorize = async (input) => {
    authorizationStarted(input.sessionId!)
    await authorizationGate
    return authorize(input)
  }
  policy.report = async (input) => { reports.push(input) }
  const handoff = scenario("codex-subscription", policy)
  const nativeTokenUpdates: string[] = []
  const running = handoff.run()
  try {
    const authorizedSessionId = await started
    await handoff.broker.stop(authorizedSessionId)
    const replacement = await handoff.broker.start(
      handoff.principal,
      { onMessage() {}, onExit() {} },
      replacementHasNative ? () => ({
        async send() { throw new Error("UNEXPECTED_NATIVE_CALL") },
        async updateToken(token: string) { nativeTokenUpdates.push(token) },
        async close() {},
      }) : undefined,
      "replacement-token",
    )
    expect(replacement.id).not.toBe(authorizedSessionId)
    releaseAuthorization()
    await running
    expect(handoff.invocation()?.state).toBe("FAILED")
    expect(handoff.nativeSpawns()).toBe(0)
    expect(handoff.nativeMethods).toEqual([])
    expect(nativeTokenUpdates).toEqual([])
    expect(reports).toMatchObject([{ sessionId: authorizedSessionId, outcome: "FAILED", reasonCode: "TARGET_RUNTIME_FAILED" }])
  } finally {
    releaseAuthorization()
    await running
    await handoff.close()
  }
})

test.each(["SESSION_START", "AUTHORIZATION", "NATIVE_START", "NATIVE_IDLE"] as const)("broker shutdown settles a handoff during %s", async (phase) => {
  const policy = createInvocationRuntimePolicy()
  const authorize = policy.authorize
  const reports: Parameters<typeof policy.report>[0][] = []
  let reachStage!: () => void
  const stageReached = new Promise<void>((resolve) => { reachStage = resolve })
  let releaseStage!: () => void
  const stageGate = new Promise<void>((resolve) => { releaseStage = resolve })
  if (phase === "AUTHORIZATION") {
    policy.authorize = async (input) => {
      const decision = await authorize(input)
      reachStage()
      await stageGate
      return decision
    }
  }
  policy.report = async (input) => { reports.push(input) }
  const handoff = scenario("codex-subscription", policy, {
    nativeOutcome: phase === "NATIVE_IDLE" ? "IDLE" : undefined,
    onNativeMethod: phase === "NATIVE_IDLE" ? (method) => { if (method === "turn/start") reachStage() } : undefined,
  })
  if (phase === "SESSION_START" || phase === "NATIVE_START") {
    const originalStart = handoff.broker.start.bind(handoff.broker)
    let starts = 0
    handoff.broker.start = async (...args: Parameters<RuntimeBroker["start"]>) => {
      const session = await originalStart(...args)
      starts += 1
      if (starts === (phase === "SESSION_START" ? 1 : 2)) {
        reachStage()
        await stageGate
      }
      return session
    }
  }
  const running = handoff.run()
  try {
    await stageReached
    const closing = handoff.broker.close()
    releaseStage()
    await Promise.all([running, closing])
    expect(handoff.invocation()).toMatchObject({ state: "FAILED", decisionReason: "TARGET_RUNTIME_INTERRUPTED" })
    expect(reports.map((report) => report.outcome)).toEqual(phase === "SESSION_START" ? [] : ["FAILED"])
    expect(handoff.nativeSpawns()).toBe(phase === "SESSION_START" || phase === "AUTHORIZATION" ? 0 : 1)
  } finally {
    releaseStage()
    await handoff.close()
  }
})

test("handoff does not claim completion when its policy outcome cannot be recorded", async () => {
  const policy = createInvocationRuntimePolicy()
  policy.report = async () => { throw new Error("RUNTIME_POLICY_REPORT_UNAVAILABLE") }
  const handoff = scenario("codex-subscription", policy)
  try {
    await handoff.run()
    expect(handoff.nativeMethods).toContain("turn/start")
    expect(handoff.invocation()).toMatchObject({ state: "FAILED", decisionReason: "RUNTIME_POLICY_REPORT_UNAVAILABLE" })
  } finally { await handoff.close() }
})
