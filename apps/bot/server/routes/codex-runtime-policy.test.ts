import { describe, expect, test } from "bun:test"

import { codexRoutes } from "./codex"

const principal = {
  tenant_id: "tenant-local",
  subject_id: "person-dylan",
  acting_client_id: "genio-one-bot",
  scopes: ["genioone-invocation"],
}

const gatewayPrincipal = { ...principal, organization_ids: ["org-engineering"] }
const activeGatewayUseCase = {
  tenant_id: gatewayPrincipal.tenant_id,
  organization_id: "org-engineering",
  use_case_id: "use-case-engineering",
  display_name: "Engineering",
  state: "ACTIVE" as const,
}
const inactiveGatewayUseCase = { ...activeGatewayUseCase, state: "DISABLED" as const }

function gatewayFetch(input: RequestInfo | URL) {
  return String(input).includes("/use-cases")
    ? Response.json([activeGatewayUseCase])
    : Response.json(gatewayPrincipal)
}

class FakeSocket {
  readonly OPEN = 1
  readyState = this.OPEN
  readonly sent: string[] = []
  closeCode: number | null = null
  closeReason = ""
  private readonly listeners = new Map<string, Array<(value?: unknown) => unknown>>()

  on(event: string, listener: (value?: unknown) => unknown) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
  }

  send(value: string) {
    this.sent.push(value)
  }

  emit(event: string, value?: unknown) {
    for (const listener of this.listeners.get(event) ?? []) void listener(value)
  }

  close(code = 1000, reason = "") {
    this.readyState = 0
    this.closeCode = code
    this.closeReason = reason
    this.emit("close")
  }
}

function waitFor(check: () => boolean) {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 1_000
    const tick = () => {
      if (check()) return resolve()
      if (Date.now() >= deadline) return reject(new Error("CODEX_ROUTE_TEST_TIMEOUT"))
      setTimeout(tick, 1)
    }
    tick()
  })
}

function runtimeDecision(input: { capabilityId: string; action: string; correlationId: string; decision?: "ALLOW" | "DENY"; constraints?: Array<{ kind: string; parameters: Record<string, unknown> }> }) {
  return {
    tenant_id: principal.tenant_id,
    subject_id: principal.subject_id,
    client_id: principal.acting_client_id,
    bot_id: "bot-dylan",
    runtime_id: "codex",
    policy_id: "one-policy.runtime.capabilities",
    policy_display_name: "Runtime capabilities",
    policy_revision: 1,
    capability_id: input.capabilityId,
    action: input.action,
    target: `runtime:codex:${input.capabilityId}`,
    decision: input.decision ?? "ALLOW",
    reason_code: input.decision === "DENY" ? "RULE_DENY:runtime" : "RULE_ALLOW:runtime",
    constraints: input.constraints ?? [],
    obligations: [{ kind: "audit", enforcement_point_id: "AGENT_RUNTIME", parameters: {} }],
    correlation_id: input.correlationId,
    session_id: "runtime-session",
    evaluated_at: 1_757_000_000,
  }
}

function createContext(
  calls: Array<Record<string, unknown>>,
  reports: Array<Record<string, unknown>>,
  denyCodex = false,
  deniedExposure: readonly string[] = [],
  constrainedExposure: readonly string[] = [],
  modelRoute: "codex-subscription" | "genio-gateway" = "codex-subscription",
  modelError?: string,
) {
  let callbacks: { onMessage(line: string): void; onExit(reason: string): void } | null = null
  const runtimeMessages: Record<string, unknown>[] = []
  const runtimeEnsureCalls: Array<{ sessionId: string; tier: string; botId?: string }> = []
  const runtime = {
    async send(message: string) { runtimeMessages.push(JSON.parse(message)) },
    async close() {},
  }
  const session = {
    id: "runtime-session",
    relaySecret: "private-relay-secret",
    principal,
    details: { kind: "local", tier: "none", cwd: "/srv/genio", desktopUrl: null, sandboxId: null, environmentId: null, execServerUrl: null, execReady: false },
    runtimeDetails: {},
    leases: {},
    desktop: { details: { kind: "local", tier: "none", cwd: "/srv/genio", desktopUrl: null, sandboxId: null, environmentId: null, execServerUrl: null, execReady: false }, close: async () => {} },
    accessToken: "token",
    eventBuffer: [],
  } as any
  const bot = { id: "bot-dylan", name: "Dylan", modelRoute, skills: [], plugins: [], bindings: [] as Array<{ resourceId: string; capabilityId: string; state: string; kind: string }>, workspacePath: "/srv/genio" }
  const botRegistry = {
    getOwned: () => bot,
    ownsThread: () => true,
    materialize: () => ({ skillRoots: [], plugins: [] }),
    timeline: { hasRunningTurns: () => false, revision: () => 1, readTurn: () => [], workContext: () => ({}) },
    memory: { recall: () => ({ memories: [] }), workSummary: () => ({}) },
    recordRuntimeEvent() {},
    saveSession() {},
    rememberThread(_botId?: string, _threadId?: string) {},
    importRuntimeHistory() {},
    setThreadHistoryStatus() {},
    setUsageContext() {},
  }
  const runtimeBroker = {
    get: (id: string) => id === session.id ? session : undefined,
    refreshWorkspaceDetails() {},
    claimBotTurn: () => () => {},
    async start(_principal: unknown, nextCallbacks: typeof callbacks) {
      callbacks = nextCallbacks
      return session
    },
    channel: () => runtime,
    async request(_sessionId: string, method: string, params: unknown) {
      runtimeMessages.push({ method, params: params as Record<string, unknown> })
      return {}
    },
    async ensure(sessionId: string, tier: string, botId?: string) {
      runtimeEnsureCalls.push({ sessionId, tier, botId })
      return session
    },
    detach() {},
    pendingInteractions: () => [],
    async respondToInteraction() {},
  }
  let sequence = 0
  const runtimePolicy = {
    async authorize(input: { capabilityId: string; action: string }) {
      const decision = runtimeDecision({ capabilityId: input.capabilityId, action: input.action, correlationId: `corr-${++sequence}` })
      if ((denyCodex && input.capabilityId === "codex.subscription") || deniedExposure.includes(input.capabilityId)) decision.decision = "DENY"
      calls.push(decision)
      return decision
    },
    async report(input: Record<string, unknown>) { reports.push(input) },
    async resolve(input: { capabilityId: string; action: string }) {
      const decision = runtimeDecision({ capabilityId: input.capabilityId, action: input.action, correlationId: `resolve-${++sequence}` })
      calls.push(decision)
      return decision
    },
    async read(input: { botId: string }) {
      const decisions = ["shell.exec", "filesystem.read", "filesystem.write", "browser.open", "web_search.query"].map((capabilityId) => runtimeDecision({
        capabilityId,
        action: "expose",
        correlationId: `exposure-${capabilityId}`,
        decision: deniedExposure.includes(capabilityId) ? "DENY" : "ALLOW",
        ...(constrainedExposure.includes(capabilityId) ? { constraints: [{ kind: "path_allowlist", parameters: { paths: ["/srv/genio"] } }] } : {}),
      }))
      return {
        tenant_id: principal.tenant_id,
        subject_id: principal.subject_id,
        client_id: principal.acting_client_id,
        bot_id: input.botId,
        runtime_id: "codex",
        policy_id: "one-policy.runtime.capabilities",
        policy_display_name: "Runtime capabilities",
        policy_revision: 1,
        decisions,
      }
    },
  }
  const modelDirectory = {
    availableRoutes: () => ["codex-subscription"],
    supports: () => true,
    async resolve(_principal: unknown, _botId: string | undefined, route?: { kind: string }, _accessToken?: string, exposure?: { decision?: string }) {
      if (modelError && route?.kind === "genio-gateway") throw new Error(modelError)
      if (exposure && exposure.decision !== "ALLOW") return []
      return [{ publicModelId: "*", displayName: "Codex", route: { kind: route?.kind ?? "codex-subscription" } }]
    },
  }
  const capabilityGate = {
    mode: "open",
    async resolve() {
      return { ...runtimeDecision({ capabilityId: "personal_bot.use", action: "use", correlationId: "bot-access" }), resource_id: "genio.personal-bot", capability_id: "personal_bot.use", policy_id: "bot-policy", model_route: modelRoute }
    },
    async require() { return "allow" },
  }
  return {
    runtimeMessages,
    runtimeEnsureCalls,
    getCallbacks: () => callbacks,
    botRegistry,
    runtimeBroker,
    modelDirectory,
    capabilityGate,
    runtimePolicy,
    workspaces: { get: () => ({ workspaceId: "workspace-dylan", provider: "e2b-self-hosted" }), active: () => null },
    handsPlacement: { async run(_actor: unknown, _provider: unknown, task: () => unknown) { return task() }, async authorizeUse() {}, async authorizeLocalEndpoint() {} },
    botSchedules: { resumeAuthorized() {} },
    session,
    botToolSessions: { config: () => ({ url: "http://bot-tools", http_headers: { Authorization: "Bearer managed" }, required: false }) },
  }
}

function activateDesktop(context: ReturnType<typeof createContext>) {
  const local = { kind: "local", tier: "none", cwd: "/local/bot", desktopUrl: null, sandboxId: null, environmentId: null, execServerUrl: null, execReady: false }
  const desktop = { kind: "e2b-self-hosted", tier: "desktop", cwd: "/home/user", desktopUrl: "https://desktop.example", sandboxId: "desktop-sandbox", environmentId: "desktop-environment", execServerUrl: "ws://desktop.example", execReady: true, workspaceId: "workspace-dylan" }
  context.session.details = desktop
  context.session.runtimeDetails = { none: local, desktop }
  return { local, desktop }
}

describe("Codex runtime policy route", () => {
  test("uses the materialized local marketplace for native plugin installation", async () => {
    const context = createContext([], [])
    const testContext = context as { botRegistry: { materialize(): unknown } }
    testContext.botRegistry.materialize = () => ({
      root: "/srv/ce-package",
      skillRoots: ["/srv/ce-package/skills/archify"],
      plugins: [{ name: "product-management", marketplace: "personal", marketplacePath: "/srv/ce-package/.agents/plugins/marketplace.json" }],
    })
    let handler: ((socket: FakeSocket) => void) | null = null
    await codexRoutes({ get: (_path: string, _options: unknown, next: (socket: FakeSocket) => void) => { handler = next } } as never, context as never)
    const socket = new FakeSocket()
    handler!(socket)
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => Response.json(principal)) as unknown as typeof fetch
    try {
      socket.emit("message", JSON.stringify({ id: 1, method: "genio/runtime/start", params: { accessToken: "token" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).method === "genio/codexReady"))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).method === "genio/runtimeReady"))
      expect(socket.sent.join("\n")).not.toContain("private-relay-secret")
      socket.emit("message", JSON.stringify({ id: 2, method: "genio/bot/select", params: { botId: "bot-dylan" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).id === 2))
      expect(context.runtimeMessages.find((message) => message.method === "skills/extraRoots/set")?.params).toEqual({ extraRoots: ["/srv/ce-package/skills/archify"] })
      expect(context.runtimeMessages.find((message) => message.method === "plugin/install")?.params).toEqual({
        pluginName: "product-management",
        marketplacePath: "/srv/ce-package/.agents/plugins/marketplace.json",
      })
      expect(context.runtimeMessages.find((message) => message.method === "plugin/list")?.params).toEqual({ cwds: ["/srv/ce-package"] })
      expect(context.runtimeMessages.find((message) => message.method === "skills/list")?.params).toEqual({
        cwds: ["/srv/ce-package"],
        forceReload: true,
      })
    } finally {
      globalThis.fetch = originalFetch
      socket.close()
    }
  })

  test("returns only a lease-bound proxied desktop URL from runtime status", async () => {
    const context = createContext([], [])
    const rawDesktop = {
      kind: "e2b-self-hosted",
      tier: "desktop",
      cwd: "/home/user",
      desktopUrl: "https://6080-sandbox-1.localhost/vnc.html?autoconnect=true&password=private-vnc-password",
      sandboxId: "sandbox-1",
      environmentId: "e2b-desktop",
      execServerUrl: "ws://runtime",
      execReady: true,
      workspaceId: "workspace-dylan",
      botId: "bot-dylan",
    }
    const desktop = {
      details: rawDesktop,
      proxy: {
        executor: { url: "http://e2b.test/", headers: { "E2b-Sandbox-Id": "sandbox-1", "E2b-Sandbox-Port": "4512" } },
        desktop: { url: "http://e2b.test/", headers: { "E2b-Sandbox-Id": "sandbox-1", "E2b-Sandbox-Port": "6080" } },
      },
      close: async () => {},
    }
    context.session.details = rawDesktop
    context.session.runtimeDetails = { desktop: rawDesktop }
    context.session.leases = { desktop }
    context.session.desktop = desktop
    let handler: ((socket: FakeSocket) => void) | null = null
    await codexRoutes({ get: (_path: string, _options: unknown, next: (socket: FakeSocket) => void) => { handler = next } } as never, context as never)
    const socket = new FakeSocket()
    handler!(socket)
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => Response.json(principal)) as unknown as typeof fetch
    try {
      socket.emit("message", JSON.stringify({ id: 1, method: "genio/runtime/start", params: { accessToken: "token" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).method === "genio/codexReady"))
      socket.emit("message", JSON.stringify({ id: 11, method: "genio/bot/select", params: { botId: "bot-dylan" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).id === 11))
      socket.emit("message", JSON.stringify({ id: 2, method: "genio/runtime/status" }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).id === 2))
      const status = socket.sent.map((line) => JSON.parse(line)).find((message) => message.id === 2)
      expect(status.result.active.desktopUrl).toStartWith("/api/desktop/runtime-session/vnc.html?desktop_grant=")
      expect(status.result.tiers.desktop.desktopUrl).toStartWith("/api/desktop/runtime-session/vnc.html?desktop_grant=")
      const desktopUrl = new URL(status.result.active.desktopUrl, "http://bot.test")
      expect([...desktopUrl.searchParams.keys()]).toEqual(["desktop_grant"])
      expect(desktopUrl.hash).toContain("password=private-vnc-password")
      expect(JSON.stringify(status)).not.toContain("6080-sandbox-1.localhost")

      const headless = {
        kind: "local",
        tier: "headless",
        cwd: "/home/user",
        desktopUrl: null,
        sandboxId: "sandbox-1",
        environmentId: "e2b-headless",
        execServerUrl: "ws://runtime",
        execReady: true,
        botId: "bot-dylan",
        workspaceId: "workspace-dylan",
      }
      context.session.details = headless
      context.session.runtimeDetails = { desktop: rawDesktop, headless }
      context.session.leases.headless = { details: headless, close: async () => {} }
      socket.emit("message", JSON.stringify({ id: 3, method: "genio/runtime/status" }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).id === 3))
      const retained = socket.sent.map((line) => JSON.parse(line)).find((message) => message.id === 3)
      expect(retained.result.active.desktopUrl).toBeNull()
      expect(retained.result.tiers.headless.desktopUrl).toBeNull()
      expect(retained.result.tiers.desktop.desktopUrl).toStartWith("/api/desktop/runtime-session/vnc.html?desktop_grant=")
      expect(new URL(retained.result.tiers.desktop.desktopUrl, "http://bot.test").hash).toContain("password=private-vnc-password")

      context.session.leases = {}
      socket.emit("message", JSON.stringify({ id: 4, method: "genio/runtime/status" }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).id === 4))
      const expired = socket.sent.map((line) => JSON.parse(line)).find((message) => message.id === 4)
      expect(expired.result.active.desktopUrl).toBeNull()
      expect(expired.result.tiers.desktop.desktopUrl).toBeNull()
    } finally {
      globalThis.fetch = originalFetch
      socket.close()
    }
  })

  test("mounts the CE starter MCP relays from its package bindings after selecting the CE documents Bot", async () => {
    const calls: Array<Record<string, unknown>> = []
    const reports: Array<Record<string, unknown>> = []
    const context = createContext(calls, reports)
    const bot = context.botRegistry.getOwned()
    context.botRegistry.getOwned = () => ({
      ...bot,
      sourceResourceId: "genio.demo.bot",
      bindings: [
        { resourceId: "genio.demo.context7", capabilityId: "context7", state: "INSTALLED", kind: "MCP" },
        { resourceId: "genio.demo.archify", capabilityId: "archify", state: "INSTALLED", kind: "MCP" },
      ],
    })
    let handler: ((socket: FakeSocket) => void) | null = null
    await codexRoutes({ get: (_path: string, _options: unknown, next: (socket: FakeSocket) => void) => { handler = next } } as never, context as never)
    const socket = new FakeSocket()
    handler!(socket)
    const originalUrl = process.env.GENIO_ONE_MCP_URL
    const originalRelay = process.env.GENIO_ONE_MCP_RELAY_ORIGIN
    const originalFetch = globalThis.fetch
    process.env.GENIO_ONE_MCP_URL = "http://one.localhost:1975/mcp"
    process.env.GENIO_ONE_MCP_RELAY_ORIGIN = "https://bot.example.test"
    let catalogRequests = 0
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith("/catalog")) {
        catalogRequests++
        return Response.json({ capabilities: [
          {
            resource_id: "genio.demo.context7",
            capability_id: "context7",
            access: "ENTITLED",
            publication_endpoint: { hostname: "context7.stellar-freight.localhost", base_path: "/" },
          },
          {
            resource_id: "genio.demo.archify",
            capability_id: "archify",
            access: "AUTO_GRANT",
            publication_endpoint: { hostname: "archify.stellar-freight.localhost", base_path: "/" },
          },
        ] })
      }
      return Response.json(principal)
    }) as unknown as typeof fetch
    try {
      socket.emit("message", JSON.stringify({ id: 1, method: "genio/runtime/start", params: { accessToken: "token" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).method === "genio/codexReady"))
      socket.emit("message", JSON.stringify({ id: 2, method: "genio/bot/select", params: { botId: "bot-dylan" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).id === 2))
      socket.emit("message", JSON.stringify({
        id: 3,
        method: "thread/start",
        params: { model: "gpt-5.6-luna", environments: [] },
      }))
      await waitFor(() => context.runtimeMessages.some((message) => message.id === 3))
      const forwarded = context.runtimeMessages.find((message) => message.id === 3) as { params: { config: Record<string, unknown> } }
      expect(forwarded.params.config["mcp_servers.genio_mcp_context7"]).toMatchObject({
        url: "https://bot.example.test/api/mcp-gateway/runtime-session/bots/bot-dylan/genio.demo.context7/mcp",
      })
      expect(forwarded.params.config["mcp_servers.genio_mcp_archify"]).toMatchObject({
        url: "https://bot.example.test/api/mcp-gateway/runtime-session/bots/bot-dylan/genio.demo.archify/mcp",
      })
      expect(catalogRequests).toBe(2)
      expect(calls.filter((call) => call.capability_id === "mcp.invoke" && call.action === "expose")).toHaveLength(4)
      expect(reports.filter((report) => report.capabilityId === "mcp.invoke" && report.action === "expose").map((report) => report.outcome)).toEqual(["ALLOW", "ALLOW", "COMPLETED", "COMPLETED"])
      expect(context.session.managedMcpMountsByBot).toEqual({
        "bot-dylan": {
          "genio.demo.context7": { resourceId: "genio.demo.context7", capabilityId: "context7", serverName: "genio_mcp_context7", hostname: "context7.stellar-freight.localhost", basePath: "/" },
          "genio.demo.archify": { resourceId: "genio.demo.archify", capabilityId: "archify", serverName: "genio_mcp_archify", hostname: "archify.stellar-freight.localhost", basePath: "/" },
        },
      })
    } finally {
      globalThis.fetch = originalFetch
      if (originalUrl === undefined) delete process.env.GENIO_ONE_MCP_URL
      else process.env.GENIO_ONE_MCP_URL = originalUrl
      if (originalRelay === undefined) delete process.env.GENIO_ONE_MCP_RELAY_ORIGIN
      else process.env.GENIO_ONE_MCP_RELAY_ORIGIN = originalRelay
      socket.close()
    }
  })

  test("does not inject a managed MCP mount whose runtime exposure is denied", async () => {
    const calls: Array<Record<string, unknown>> = []
    const reports: Array<Record<string, unknown>> = []
    const context = createContext(calls, reports, false, ["mcp.invoke"])
    const bot = context.botRegistry.getOwned()
    context.botRegistry.getOwned = () => ({
      ...bot,
      sourceResourceId: "genio.demo.bot",
      bindings: [{ resourceId: "genio.demo.context7", capabilityId: "context7", state: "INSTALLED", kind: "MCP" }],
    })
    let handler: ((socket: FakeSocket) => void) | null = null
    await codexRoutes({ get: (_path: string, _options: unknown, next: (socket: FakeSocket) => void) => { handler = next } } as never, context as never)
    const socket = new FakeSocket()
    handler!(socket)
    const originalUrl = process.env.GENIO_ONE_MCP_URL
    const originalFetch = globalThis.fetch
    process.env.GENIO_ONE_MCP_URL = "http://one.localhost:1975/mcp"
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith("/catalog")) return Response.json({ capabilities: [{
        resource_id: "genio.demo.context7",
        capability_id: "context7",
        access: "ENTITLED",
        publication_endpoint: { hostname: "context7.stellar-freight.localhost", base_path: "/" },
      }] })
      return Response.json(principal)
    }) as unknown as typeof fetch
    try {
      socket.emit("message", JSON.stringify({ id: 1, method: "genio/runtime/start", params: { accessToken: "token" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).method === "genio/codexReady"))
      socket.emit("message", JSON.stringify({ id: 2, method: "genio/bot/select", params: { botId: "bot-dylan" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).id === 2))
      expect(context.session.managedMcpMountsByBot).toEqual({ "bot-dylan": {} })
      expect(calls.some((call) => call.capability_id === "mcp.invoke" && call.action === "expose" && call.decision === "DENY")).toBe(true)
      expect(reports.some((report) => report.capabilityId === "mcp.invoke" && report.action === "expose" && report.outcome === "DENY")).toBe(true)
      socket.emit("message", JSON.stringify({ id: 3, method: "thread/start", params: { model: "gpt-5.6-luna", environments: [] } }))
      await waitFor(() => context.runtimeMessages.some((message) => message.id === 3))
      const forwarded = context.runtimeMessages.find((message) => message.id === 3) as { params: { config: Record<string, unknown> } }
      expect(forwarded.params.config["mcp_servers.genio_mcp_context7"]).toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
      if (originalUrl === undefined) delete process.env.GENIO_ONE_MCP_URL
      else process.env.GENIO_ONE_MCP_URL = originalUrl
      socket.close()
    }
  })

  test("mounts only installed generic MCP catalog endpoints after selecting a Bot", async () => {
    const context = createContext([], [])
    const bot = context.botRegistry.getOwned()
    const notionResourceId = "resource-2a55a5d9-3d76-40af-b65e-04babfe93a8f"
    context.botRegistry.getOwned = () => ({
      ...bot,
      sourceResourceId: "custom-notion-bot",
      bindings: [{ resourceId: notionResourceId, capabilityId: "notion.search", state: "INSTALLED", kind: "MCP" }],
    })
    let handler: ((socket: FakeSocket) => void) | null = null
    await codexRoutes({ get: (_path: string, _options: unknown, next: (socket: FakeSocket) => void) => { handler = next } } as never, context as never)
    const socket = new FakeSocket()
    handler!(socket)
    const originalUrl = process.env.GENIO_ONE_MCP_URL
    const originalRelay = process.env.GENIO_ONE_MCP_RELAY_ORIGIN
    const originalFetch = globalThis.fetch
    process.env.GENIO_ONE_MCP_URL = "http://one.localhost:1975/mcp"
    process.env.GENIO_ONE_MCP_RELAY_ORIGIN = "https://bot.example.test"
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith("/catalog")) return Response.json({ capabilities: [
        {
          resource_id: notionResourceId,
          capability_id: "notion.search",
          access: "ENTITLED",
          publication_endpoint: { hostname: "notion.stellar-freight.localhost", base_path: "/mcp" },
        },
        {
          resource_id: "resource-uninstalled",
          capability_id: "mcp.invoke",
          access: "AUTO_GRANT",
          publication_endpoint: { hostname: "uninstalled.stellar-freight.localhost", base_path: "/mcp" },
        },
      ] })
      return Response.json(principal)
    }) as unknown as typeof fetch
    try {
      socket.emit("message", JSON.stringify({ id: 1, method: "genio/runtime/start", params: { accessToken: "token" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).method === "genio/codexReady"))
      socket.emit("message", JSON.stringify({ id: 2, method: "genio/bot/select", params: { botId: "bot-dylan" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).id === 2))
      socket.emit("message", JSON.stringify({
        id: 3,
        method: "thread/start",
        params: { model: "gpt-5.6-luna", environments: [] },
      }))
      await waitFor(() => context.runtimeMessages.some((message) => message.id === 3))
      const forwarded = context.runtimeMessages.find((message) => message.id === 3) as { params: { config: Record<string, unknown> } }
      expect(forwarded.params.config["mcp_servers.genio_mcp_notion"]).toMatchObject({
        url: `https://bot.example.test/api/mcp-gateway/runtime-session/bots/bot-dylan/${notionResourceId}/mcp`,
      })
      expect(forwarded.params.config["mcp_servers.genio_mcp_uninstalled"]).toBeUndefined()
      expect(context.session.managedMcpMountsByBot).toEqual({
        "bot-dylan": {
          [notionResourceId]: {
            resourceId: notionResourceId,
            capabilityId: "notion.search",
            serverName: "genio_mcp_notion",
            hostname: "notion.stellar-freight.localhost",
            basePath: "/mcp",
          },
        },
      })
    } finally {
      globalThis.fetch = originalFetch
      if (originalUrl === undefined) delete process.env.GENIO_ONE_MCP_URL
      else process.env.GENIO_ONE_MCP_URL = originalUrl
      if (originalRelay === undefined) delete process.env.GENIO_ONE_MCP_RELAY_ORIGIN
      else process.env.GENIO_ONE_MCP_RELAY_ORIGIN = originalRelay
      socket.close()
    }
  })

  test("binds a selected Bot, strips forged native config, forces sandbox policy, and reports completion", async () => {
    const calls: Array<Record<string, unknown>> = []
    const reports: Array<Record<string, unknown>> = []
    const context = createContext(calls, reports, false, ["browser.open", "web_search.query"])
    let handler: ((socket: FakeSocket) => void) | null = null
    await codexRoutes({ get: (_path: string, _options: unknown, next: (socket: FakeSocket) => void) => { handler = next } } as never, context as never)
    const socket = new FakeSocket()
    handler!(socket)

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify(principal), { status: 200 })) as unknown as typeof fetch
    try {
      socket.emit("message", JSON.stringify({ id: 1, method: "genio/runtime/start", params: { accessToken: "token" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).method === "genio/codexReady"))
      socket.emit("message", JSON.stringify({ id: 2, method: "genio/bot/select", params: { botId: "bot-dylan" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).id === 2))
      socket.emit("message", JSON.stringify({
        id: 3,
        method: "thread/start",
        params: {
          model: "gpt-5.6-luna",
          futureExecutionOverride: { unrestricted: true },
          mockExperimentalField: "forged",
          config: { "mcp_servers.evil": { url: "http://attacker" }, "features.memories": true },
          modelProvider: "evil-provider",
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          cwd: "/etc",
          runtimeWorkspaceRoots: ["/etc"],
          environments: [],
        },
      }))
      await waitFor(() => context.runtimeMessages.some((message) => message.id === 3))
      const forwarded = context.runtimeMessages.find((message) => message.id === 3) as { params: Record<string, any> }
      expect(forwarded.params.approvalPolicy).toBe("on-request")
      expect(forwarded.params.sandbox).toBe("read-only")
      expect(forwarded.params.cwd).toBe("/srv/genio")
      expect(forwarded.params.runtimeWorkspaceRoots).toEqual([])
      expect(forwarded.params.config["mcp_servers.evil"]).toBeUndefined()
      expect(forwarded.params.config["features.memories"]).toBe(false)
      expect(forwarded.params.config["features.shell_tool"]).toBe(false)
      expect(forwarded.params.config["features.unified_exec"]).toBe(false)
      expect(forwarded.params.config["features.browser_use"]).toBe(false)
      expect(forwarded.params.config.web_search).toBe("disabled")
      expect(forwarded.params.modelProvider).toBeUndefined()
      expect(forwarded.params.futureExecutionOverride).toBeUndefined()
      expect(forwarded.params.mockExperimentalField).toBeUndefined()
      expect(calls.some((call) => call.capability_id === "codex.subscription" && call.action === "use")).toBe(true)

      context.getCallbacks()!.onMessage(JSON.stringify({ id: 3, result: { thread: { id: "thread-dylan" } } }))
      await waitFor(() => reports.some((report) => report.correlationId === "corr-2"))
      expect(reports.find((report) => report.correlationId === "corr-2")?.outcome).toBe("ALLOW")
      for (const [id, method] of [[4, "thread/resume"], [5, "turn/start"]] as const) {
        const input = [{ type: "text", text: "Continue", text_elements: [] }]
        socket.emit("message", JSON.stringify({ id, method, params: {
          threadId: "thread-dylan", input, excludeTurns: true, effort: "high", serviceTier: "default",
          futureExecutionOverride: { unrestricted: true }, permissions: "unrestricted", config: { unsafe: true },
        } }))
        await waitFor(() => context.runtimeMessages.some((message) => message.id === id))
        const next = context.runtimeMessages.find((message) => message.id === id) as { params: Record<string, unknown> }
        expect(next.params.threadId).toBe("thread-dylan")
        expect(next.params.serviceTier).toBe("default")
        expect(next.params.futureExecutionOverride).toBeUndefined()
        expect(next.params.permissions).toBeUndefined()
        if (method === "turn/start") {
          expect(next.params.input).toEqual(input)
          expect(next.params.effort).toBe("high")
          expect(next.params.excludeTurns).toBeUndefined()
          expect(next.params.config).toBeUndefined()
          expect(next.params.sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false })
        } else {
          expect(next.params.excludeTurns).toBe(true)
          expect(next.params.input).toBeUndefined()
          expect(next.params.effort).toBeUndefined()
        }
        context.getCallbacks()!.onMessage(JSON.stringify({ id, result: {} }))
      }

    } finally {
      globalThis.fetch = originalFetch
      socket.close()
    }
  })

  test("denies a personal Codex Bot before materialization and reports the denial", async () => {
    const calls: Array<Record<string, unknown>> = []
    const reports: Array<Record<string, unknown>> = []
    const context = createContext(calls, reports, true)
    let handler: ((socket: FakeSocket) => void) | null = null
    await codexRoutes({ get: (_path: string, _options: unknown, next: (socket: FakeSocket) => void) => { handler = next } } as never, context as never)
    const socket = new FakeSocket()
    handler!(socket)
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify(principal), { status: 200 })) as unknown as typeof fetch
    try {
      socket.emit("message", JSON.stringify({ id: 1, method: "genio/runtime/start", params: { accessToken: "token" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).method === "genio/codexReady"))
      socket.emit("message", JSON.stringify({ id: 2, method: "genio/bot/select", params: { botId: "bot-dylan" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).id === 2 && JSON.parse(line).error?.code))
      expect(reports.find((report) => report.correlationId === "corr-1")?.outcome).toBe("DENY")
      expect(socket.sent.some((line) => JSON.parse(line).method === "genio/runtime/error")).toBe(true)
      expect(socket.sent.some((line) => JSON.parse(line).method === "genio/runtimeError")).toBe(true)
      expect(context.runtimeMessages.some((message) => message.method === "skills/extraRoots/set")).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
      socket.close()
    }
  })

  test("surfaces a disabled personal Bot connection without treating it as session expiry", async () => {
    const calls: Array<Record<string, unknown>> = []
    const reports: Array<Record<string, unknown>> = []
    const context = createContext(calls, reports)
    context.capabilityGate.resolve = (async () => ({
      ...runtimeDecision({ capabilityId: "personal_bot.use", action: "use", correlationId: "bot-access", decision: "DENY" }),
      resource_id: "genio.personal-bot",
      policy_id: "one-policy.first-party.bot-default",
      policy_revision: 2,
      model_route: null,
      reason_code: "BOT_CONNECTION_DISABLED",
    })) as never
    let handler: ((socket: FakeSocket) => void) | null = null
    await codexRoutes({ get: (_path: string, _options: unknown, next: (socket: FakeSocket) => void) => { handler = next } } as never, context as never)
    const socket = new FakeSocket()
    handler!(socket)
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify(principal), { status: 200 })) as unknown as typeof fetch
    try {
      socket.emit("message", JSON.stringify({ method: "genio/runtime/start", params: { accessToken: "token" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).method === "genio/runtime/error"))
      const error = socket.sent.map((line) => JSON.parse(line)).find((message) => message.method === "genio/runtime/error")
      expect(error?.params.message).toBe("BOT_CONNECTION_DISABLED")
      expect(socket.closeCode).toBe(1008)
      expect(socket.closeReason).toBe("BOT_CONNECTION_DISABLED")
      expect(socket.sent.some((line) => JSON.parse(line).method === "genio/codexReady")).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
      socket.close()
    }
  })

  test("keeps the session usable when the company model catalog has no entitlement", async () => {
    const calls: Array<Record<string, unknown>> = []
    const reports: Array<Record<string, unknown>> = []
    const context = createContext(calls, reports, false, [], [], "genio-gateway", "BOT_MODEL_NOT_ENTITLED")
    let handler: ((socket: FakeSocket) => void) | null = null
    await codexRoutes({ get: (_path: string, _options: unknown, next: (socket: FakeSocket) => void) => { handler = next } } as never, context as never)
    const socket = new FakeSocket()
    handler!(socket)
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify(principal), { status: 200 })) as unknown as typeof fetch
    try {
      socket.emit("message", JSON.stringify({ id: 1, method: "genio/runtime/start", params: { accessToken: "token" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).method === "genio/codexReady"))
      const ready = socket.sent.map((line) => JSON.parse(line)).find((message) => message.method === "genio/codexReady")
      expect(ready?.params.modelDirectory).toBe("genio-gateway")
      expect(ready?.params.models).toEqual([])
      expect(socket.closeCode).toBeNull()
    } finally {
      globalThis.fetch = originalFetch
      socket.close()
    }
  })

  test.each([
    ["missing organization claim", principal, []],
    ["empty organization claims", { ...principal, organization_ids: [] }, []],
    ["no active Use Case authority", gatewayPrincipal, [inactiveGatewayUseCase]],
  ] as const)("fails closed before an existing Gateway Bot selection can proceed: %s", async (_label, identity, useCases) => {
    const modelLookups: string[] = []
    const reports: Array<Record<string, unknown>> = []
    const context = createContext([], reports)
    const bot = context.botRegistry.getOwned()
    bot.modelRoute = "genio-gateway"
    context.modelDirectory.resolve = async () => {
      modelLookups.push("resolved")
      return [{ publicModelId: "company-model", displayName: "Company model", route: { kind: "genio-gateway" } }]
    }
    let handler: ((socket: FakeSocket) => void) | null = null
    await codexRoutes({ get: (_path: string, _options: unknown, next: (socket: FakeSocket) => void) => { handler = next } } as never, context as never)
    const socket = new FakeSocket()
    handler!(socket)
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/organizations/org-engineering/use-cases")) return Response.json(useCases)
      return Response.json(identity)
    }) as typeof fetch
    try {
      socket.emit("message", JSON.stringify({ id: 1, method: "genio/runtime/start", params: { accessToken: "token" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).method === "genio/codexReady"))
      const runtimeMessagesBeforeSelection = context.runtimeMessages.length
      socket.emit("message", JSON.stringify({ id: 2, method: "genio/bot/select", params: { botId: bot.id } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).id === 2 && JSON.parse(line).error?.code))
      const selection = socket.sent.map((line) => JSON.parse(line)).find((message) => message.id === 2)
      expect(selection.error.code).toBe("USE_CASE_REQUIRED")
      expect(selection.result).toBeUndefined()
      expect(modelLookups).toEqual([])
      expect(context.runtimeMessages.length).toBe(runtimeMessagesBeforeSelection)
      expect(context.session.selectedBotId).toBeNull()
      expect(reports.some((report) => report.outcome === "ALLOW" || report.outcome === "COMPLETED")).toBe(false)

      socket.emit("message", JSON.stringify({ id: 3, method: "genio/runtime/ensure", params: { tier: "headless", botId: bot.id } }))
      await waitFor(() => socket.sent.some((line) => {
        const message = JSON.parse(line)
        return message.method === "genio/runtime/error" && message.params?.message === "BOT_NOT_SELECTED"
      }))
      expect(context.runtimeEnsureCalls).toHaveLength(0)
    } finally {
      globalThis.fetch = originalFetch
      socket.close()
    }
  })

  test("allows an existing Gateway Bot with one active Use Case", async () => {
    const modelLookups: Array<{ botId: string | undefined; route: string | undefined }> = []
    const context = createContext([], [])
    const bot = context.botRegistry.getOwned()
    bot.modelRoute = "genio-gateway"
    context.modelDirectory.resolve = async (_principal, botId, route) => {
      modelLookups.push({ botId, route: route?.kind })
      return [{ publicModelId: "company-model", displayName: "Company model", route: { kind: "genio-gateway" } }]
    }
    let handler: ((socket: FakeSocket) => void) | null = null
    await codexRoutes({ get: (_path: string, _options: unknown, next: (socket: FakeSocket) => void) => { handler = next } } as never, context as never)
    const socket = new FakeSocket()
    handler!(socket)
    const originalFetch = globalThis.fetch
    globalThis.fetch = gatewayFetch as unknown as typeof fetch
    try {
      socket.emit("message", JSON.stringify({ id: 1, method: "genio/runtime/start", params: { accessToken: "token" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).method === "genio/codexReady"))
      socket.emit("message", JSON.stringify({ id: 2, method: "genio/bot/select", params: { botId: bot.id } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).id === 2))
      const selection = socket.sent.map((line) => JSON.parse(line)).find((message) => message.id === 2)
      expect(selection.error).toBeUndefined()
      expect(selection.result).toMatchObject({ botId: bot.id, modelDirectory: "genio-gateway", models: [{ publicModelId: "company-model" }] })
      expect(modelLookups).toEqual([{ botId: bot.id, route: "genio-gateway" }])
      expect(context.session.selectedBotId).toBe(bot.id)
    } finally {
      globalThis.fetch = originalFetch
      socket.close()
    }
  })

  test("refreshes the selected Bot company model catalog after subscription bootstrap", async () => {
    const context = createContext([], [], false)
    const bot = context.botRegistry.getOwned()
    const lookups: Array<{ botId: string | undefined; route: string | undefined }> = []
    context.modelDirectory.resolve = async (_principal, botId, route) => {
      lookups.push({ botId, route: route?.kind })
      return [{ publicModelId: "company-model", displayName: "Company model", route: { kind: "genio-gateway" } }]
    }
    let handler: ((socket: FakeSocket) => void) | null = null
    await codexRoutes({ get: (_path: string, _options: unknown, next: (socket: FakeSocket) => void) => { handler = next } } as never, context as never)
    const socket = new FakeSocket()
    handler!(socket)
    const originalFetch = globalThis.fetch
    globalThis.fetch = gatewayFetch as unknown as typeof fetch
    try {
      socket.emit("message", JSON.stringify({ id: 1, method: "genio/runtime/start", params: { accessToken: "token" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).method === "genio/codexReady"))
      bot.modelRoute = "genio-gateway"
      socket.emit("message", JSON.stringify({ id: 2, method: "genio/bot/select", params: { botId: bot.id } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).id === 2))
      const result = socket.sent.map((line) => JSON.parse(line)).find(message => message.id === 2).result
      expect(result.modelDirectory).toBe("genio-gateway")
      expect(result.models.map((model: { publicModelId: string }) => model.publicModelId)).toEqual(["company-model"])
      expect(lookups).toEqual([{ botId: bot.id, route: "genio-gateway" }])
      bot.modelRoute = "codex-subscription"
      socket.emit("message", JSON.stringify({ id: 3, method: "genio/bot/select", params: { botId: bot.id } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).id === 3))
      const restored = socket.sent.map((line) => JSON.parse(line)).find(message => message.id === 3).result
      expect(restored.models).toEqual([])
    } finally { globalThis.fetch = originalFetch; socket.close() }
  })

  test("filters company models by Runtime Policy exposure and shows them again after policy restore", async () => {
    const calls: Array<Record<string, unknown>> = []
    const reports: Array<Record<string, unknown>> = []
    const context = createContext(calls, reports, false, [], [], "genio-gateway")
    let exposure: "ALLOW" | "DENY" = "DENY"
    const resolvePolicy = context.runtimePolicy.resolve
    context.runtimePolicy.resolve = async (input) => {
      const decision = await resolvePolicy(input)
      if (input.capabilityId === "model.invoke" && input.action === "expose") decision.decision = exposure
      return decision
    }
    const bot = context.botRegistry.getOwned()
    let handler: ((socket: FakeSocket) => void) | null = null
    await codexRoutes({ get: (_path: string, _options: unknown, next: (socket: FakeSocket) => void) => { handler = next } } as never, context as never)
    const socket = new FakeSocket()
    handler!(socket)
    const originalFetch = globalThis.fetch
    globalThis.fetch = gatewayFetch as unknown as typeof fetch
    try {
      socket.emit("message", JSON.stringify({ id: 1, method: "genio/runtime/start", params: { accessToken: "token" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).method === "genio/codexReady"))
      const ready = socket.sent.map((line) => JSON.parse(line)).find((message) => message.method === "genio/codexReady")
      expect(ready?.params.models).toEqual([])

      socket.emit("message", JSON.stringify({ id: 2, method: "genio/bot/select", params: { botId: bot.id } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).id === 2))
      const denied = socket.sent.map((line) => JSON.parse(line)).find((message) => message.id === 2)
      expect(denied?.result.models).toEqual([])

      exposure = "ALLOW"
      socket.emit("message", JSON.stringify({ id: 3, method: "genio/bot/select", params: { botId: bot.id } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).id === 3))
      const restored = socket.sent.map((line) => JSON.parse(line)).find((message) => message.id === 3)
      expect(restored?.result.models.map((model: { publicModelId: string }) => model.publicModelId)).toEqual(["*"])
      expect(calls.filter((call) => call.capability_id === "model.invoke" && call.action === "expose")).toHaveLength(2)
    } finally {
      globalThis.fetch = originalFetch
      socket.close()
    }
  })

  test.each([false, true])("late Bot selections cannot replace or clear the newer selection (old failure=%s)", async (failOld) => {
    const context = createContext([], [], false)
    const base = context.botRegistry.getOwned()
    context.botRegistry.getOwned = ((id: string) => ({ ...base, id, modelRoute: "genio-gateway" })) as typeof context.botRegistry.getOwned
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let waiting = false
    context.modelDirectory.resolve = async (_principal, botId) => {
      if (botId === "old-bot") {
        waiting = true
        await gate
        if (failOld) throw new Error("CATALOG_UNAVAILABLE")
      }
      return [{ publicModelId: "company-model", displayName: "Company model", route: { kind: "genio-gateway" } }]
    }
    let handler: ((socket: FakeSocket) => void) | null = null
    await codexRoutes({ get: (_path: string, _options: unknown, next: (socket: FakeSocket) => void) => { handler = next } } as never, context as never)
    const socket = new FakeSocket()
    handler!(socket)
    const originalFetch = globalThis.fetch
    globalThis.fetch = gatewayFetch as unknown as typeof fetch
    try {
      socket.emit("message", JSON.stringify({ id: 1, method: "genio/runtime/start", params: { accessToken: "token" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).method === "genio/codexReady"))
      socket.emit("message", JSON.stringify({ id: 2, method: "genio/bot/select", params: { botId: "old-bot" } }))
      await waitFor(() => waiting)
      socket.emit("message", JSON.stringify({ id: 3, method: "genio/bot/select", params: { botId: "new-bot" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).id === 3))
      expect(context.session.selectedBotId).toBe("new-bot")
      release()
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).id === 2))
      expect(context.session.selectedBotId).toBe("new-bot")
      const stale = socket.sent.map((line) => JSON.parse(line)).find(message => message.id === 2)
      expect(stale.error.code).toBe("BOT_SELECTION_SUPERSEDED")
      expect(socket.sent.some((line) => JSON.parse(line).method === "genio/runtime/error")).toBe(false)
    } finally { release(); globalThis.fetch = originalFetch; socket.close() }
  })

  test("a stale Codex audit failure remains recorded without failing the newer Bot UI", async () => {
    const context = createContext([], [], false)
    const base = context.botRegistry.getOwned()
    context.botRegistry.getOwned = ((id: string) => ({ ...base, id, modelRoute: id === "old-bot" ? "codex-subscription" : "genio-gateway" })) as typeof context.botRegistry.getOwned
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let waiting = false
    let oldReportAttempted = false
    const authorize = context.runtimePolicy.authorize
    context.runtimePolicy.authorize = async (input) => {
      const decision = await authorize(input)
      if (input.capabilityId === "codex.subscription") { waiting = true; await gate }
      return decision
    }
    context.runtimePolicy.report = async input => {
      if (input.botId === "old-bot") { oldReportAttempted = true; throw new Error("AUDIT_OFFLINE") }
    }
    let handler: ((socket: FakeSocket) => void) | null = null
    await codexRoutes({ get: (_path: string, _options: unknown, next: (socket: FakeSocket) => void) => { handler = next } } as never, context as never)
    const socket = new FakeSocket()
    handler!(socket)
    const originalFetch = globalThis.fetch
    globalThis.fetch = gatewayFetch as unknown as typeof fetch
    try {
      socket.emit("message", JSON.stringify({ id: 1, method: "genio/runtime/start", params: { accessToken: "token" } }))
      await waitFor(() => socket.sent.some(line => JSON.parse(line).method === "genio/codexReady"))
      socket.emit("message", JSON.stringify({ id: 2, method: "genio/bot/select", params: { botId: "old-bot" } }))
      await waitFor(() => waiting)
      socket.emit("message", JSON.stringify({ id: 3, method: "genio/bot/select", params: { botId: "new-bot" } }))
      await waitFor(() => socket.sent.some(line => JSON.parse(line).id === 3))
      release()
      await waitFor(() => socket.sent.some(line => JSON.parse(line).id === 2))
      expect(oldReportAttempted).toBe(true)
      expect(context.session.selectedBotId).toBe("new-bot")
      expect(socket.sent.some(line => JSON.parse(line).method === "genio/runtime/error")).toBe(false)
    } finally { release(); globalThis.fetch = originalFetch; socket.close() }
  })

  test("applies PDP exposure to a server-owned thread config for a provisioned runtime", async () => {
    const calls: Array<Record<string, unknown>> = []
    const reports: Array<Record<string, unknown>> = []
    const context = createContext(calls, reports, false, ["browser.open", "web_search.query"])
    context.session.details = { kind: "local", tier: "headless", cwd: "/srv/genio", desktopUrl: null, sandboxId: "sandbox-1", environmentId: "e2b-headless", execServerUrl: "ws://runtime", execReady: true }
    context.session.runtimeDetails = {
      headless: context.session.details,
    }
    let handler: ((socket: FakeSocket) => void) | null = null
    await codexRoutes({ get: (_path: string, _options: unknown, next: (socket: FakeSocket) => void) => { handler = next } } as never, context as never)
    const socket = new FakeSocket()
    handler!(socket)
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify(principal), { status: 200 })) as unknown as typeof fetch
    try {
      socket.emit("message", JSON.stringify({ id: 1, method: "genio/runtime/start", params: { accessToken: "token" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).method === "genio/codexReady"))
      socket.emit("message", JSON.stringify({ id: 2, method: "genio/bot/select", params: { botId: "bot-dylan" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).id === 2))
      socket.emit("message", JSON.stringify({
        id: 3,
        method: "thread/start",
        params: {
          model: "gpt-5.6-luna",
          environments: [{ environmentId: "e2b-headless", cwd: "/etc", runtimeWorkspaceRoots: ["/etc"] }],
        },
      }))
      await waitFor(() => context.runtimeMessages.some((message) => message.id === 3))
      const forwarded = context.runtimeMessages.find((message) => message.id === 3) as { params: Record<string, any> }
      expect(forwarded.params.config["features.shell_tool"]).toBe(true)
      expect(forwarded.params.config["features.unified_exec"]).toBe(true)
      expect(forwarded.params.config["features.browser_use"]).toBe(false)
      expect(forwarded.params.config.web_search).toBe("disabled")
      expect(forwarded.params.sandbox).toBe("workspace-write")
    } finally {
      globalThis.fetch = originalFetch
      socket.close()
    }
  })

  test.each(["headless", "desktop"] as const)("denies an explicitly owned %s execution turn before forwarding when the PDP denies shell", async (tier) => {
    const calls: Array<Record<string, unknown>> = []
    const reports: Array<Record<string, unknown>> = []
    const context = createContext(calls, reports, false, ["shell.exec"])
    const environmentId = `e2b-${tier}`
    context.session.details = { kind: "e2b-self-hosted", tier, cwd: "/srv/genio", desktopUrl: tier === "desktop" ? "https://desktop.example" : null, sandboxId: "sandbox-1", environmentId, execServerUrl: "ws://runtime", execReady: true, workspaceId: "workspace-dylan" }
    context.session.runtimeDetails = {
      [tier]: context.session.details,
    }
    let handler: ((socket: FakeSocket) => void) | null = null
    await codexRoutes({ get: (_path: string, _options: unknown, next: (socket: FakeSocket) => void) => { handler = next } } as never, context as never)
    const socket = new FakeSocket()
    handler!(socket)
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify(principal), { status: 200 })) as unknown as typeof fetch
    try {
      socket.emit("message", JSON.stringify({ id: 1, method: "genio/runtime/start", params: { accessToken: "token" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).method === "genio/codexReady"))
      socket.emit("message", JSON.stringify({ id: 2, method: "genio/bot/select", params: { botId: "bot-dylan" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).id === 2))
      socket.emit("message", JSON.stringify({
        id: 3,
        method: "turn/start",
        params: {
          threadId: "thread-dylan",
          input: [{ type: "text", text: "run a command" }],
          environments: [{ environmentId, cwd: "/srv/genio", runtimeWorkspaceRoots: ["/srv/genio"] }],
        },
      }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).id === 3 && JSON.parse(line).error?.code))
      expect(calls.some((call) => call.capability_id === "shell.exec" && call.action === "execute" && call.decision === "DENY")).toBe(true)
      expect(context.runtimeMessages.some((message) => message.id === 3)).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
      socket.close()
    }
  })

  test("keeps native exposure closed when the PDP returns an unsupported constraint", async () => {
    const calls: Array<Record<string, unknown>> = []
    const reports: Array<Record<string, unknown>> = []
    const context = createContext(calls, reports, false, [], ["shell.exec"])
    context.session.details = { kind: "local", tier: "headless", cwd: "/srv/genio", desktopUrl: null, sandboxId: "sandbox-1", environmentId: "e2b-headless", execServerUrl: "ws://runtime", execReady: true }
    context.session.runtimeDetails = {
      headless: context.session.details,
    }
    let handler: ((socket: FakeSocket) => void) | null = null
    await codexRoutes({ get: (_path: string, _options: unknown, next: (socket: FakeSocket) => void) => { handler = next } } as never, context as never)
    const socket = new FakeSocket()
    handler!(socket)
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify(principal), { status: 200 })) as unknown as typeof fetch
    try {
      socket.emit("message", JSON.stringify({ id: 1, method: "genio/runtime/start", params: { accessToken: "token" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).method === "genio/codexReady"))
      socket.emit("message", JSON.stringify({ id: 2, method: "genio/bot/select", params: { botId: "bot-dylan" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).id === 2))
      socket.emit("message", JSON.stringify({ id: 3, method: "thread/start", params: { environments: [{ environmentId: "e2b-headless" }] } }))
      await waitFor(() => context.runtimeMessages.some((message) => message.id === 3))
      const forwarded = context.runtimeMessages.find((message) => message.id === 3) as { params: Record<string, any> }
      expect(forwarded.params.config["features.shell_tool"]).toBe(false)
      expect(forwarded.params.config["features.unified_exec"]).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
      socket.close()
    }
  })

  test("does not restore a remote execution environment from an explicit null override", async () => {
    const calls: Array<Record<string, unknown>> = []
    const reports: Array<Record<string, unknown>> = []
    const context = createContext(calls, reports)
    context.session.details = { kind: "local", tier: "headless", cwd: "/srv/genio", desktopUrl: null, sandboxId: "sandbox-1", environmentId: "e2b-headless", execServerUrl: "ws://runtime", execReady: true }
    context.session.runtimeDetails = {
      none: { kind: "local", tier: "none", cwd: "/local/bot", desktopUrl: null, sandboxId: null, environmentId: null, execServerUrl: null, execReady: false },
      headless: context.session.details,
    }
    let handler: ((socket: FakeSocket) => void) | null = null
    await codexRoutes({ get: (_path: string, _options: unknown, next: (socket: FakeSocket) => void) => { handler = next } } as never, context as never)
    const socket = new FakeSocket()
    handler!(socket)
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify(principal), { status: 200 })) as unknown as typeof fetch
    try {
      socket.emit("message", JSON.stringify({ id: 1, method: "genio/runtime/start", params: { accessToken: "token" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).method === "genio/codexReady"))
      socket.emit("message", JSON.stringify({ id: 2, method: "genio/bot/select", params: { botId: "bot-dylan" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).id === 2))
      socket.emit("message", JSON.stringify({ id: 3, method: "thread/start", params: { environments: null } }))
      await waitFor(() => context.runtimeMessages.some((message) => message.id === 3))
      const forwarded = context.runtimeMessages.find((message) => message.id === 3) as { params: Record<string, any> }
      expect(forwarded.params.config["features.shell_tool"]).toBe(false)
      expect(forwarded.params.sandbox).toBe("read-only")
    } finally {
      globalThis.fetch = originalFetch
      socket.close()
    }
  })

  test.each([
    ["thread/start", "omitted", { model: "gpt-5.6-luna" }],
    ["thread/start", "empty", { model: "gpt-5.6-luna", environments: [] }],
    ["turn/start", "omitted", { threadId: "thread-dylan", input: [{ type: "text", text: "Continue" }] }],
    ["turn/start", "empty", { threadId: "thread-dylan", input: [{ type: "text", text: "Continue" }], environments: [] }],
  ] as const)("forwards %s with %s native intent as local-only", async (method, _intent, params) => {
    const calls: Array<Record<string, unknown>> = []
    const reports: Array<Record<string, unknown>> = []
    const context = createContext(calls, reports, false, ["shell.exec"])
    const { local } = activateDesktop(context)
    let handler: ((socket: FakeSocket) => void) | null = null
    await codexRoutes({ get: (_path: string, _options: unknown, next: (socket: FakeSocket) => void) => { handler = next } } as never, context as never)
    const socket = new FakeSocket()
    handler!(socket)
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify(principal), { status: 200 })) as unknown as typeof fetch
    try {
      socket.emit("message", JSON.stringify({ id: 1, method: "genio/runtime/start", params: { accessToken: "token" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).method === "genio/codexReady"))
      socket.emit("message", JSON.stringify({ id: 2, method: "genio/bot/select", params: { botId: "bot-dylan" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).id === 2))
      socket.emit("message", JSON.stringify({ id: 3, method, params }))
      await waitFor(() => context.runtimeMessages.some((message) => message.id === 3))
      const forwarded = context.runtimeMessages.find((message) => message.id === 3) as { params: Record<string, any> }
      expect(forwarded.params.environments).toEqual([])
      expect(forwarded.params.cwd).toBe(local.cwd)
      expect(forwarded.params.runtimeWorkspaceRoots).toEqual([])
      if (method === "thread/start") expect(forwarded.params.config["features.shell_tool"]).toBe(false)
      else expect(forwarded.params.sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false })
      expect(calls.some((call) => call.capability_id === "shell.exec" && call.action === "execute")).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
      socket.close()
    }
  })

  test("preserves explicit owned headless resume intent without forwarding an unsupported environment field", async () => {
    const calls: Array<Record<string, unknown>> = []
    const reports: Array<Record<string, unknown>> = []
    const context = createContext(calls, reports)
    activateDesktop(context)
    const headless = { kind: "e2b-self-hosted", tier: "headless", cwd: "/workspace/headless", desktopUrl: null, sandboxId: "headless-sandbox", environmentId: "headless-environment", execServerUrl: "ws://headless.example", execReady: true, workspaceId: "workspace-dylan" }
    context.session.runtimeDetails.headless = headless
    let handler: ((socket: FakeSocket) => void) | null = null
    await codexRoutes({ get: (_path: string, _options: unknown, next: (socket: FakeSocket) => void) => { handler = next } } as never, context as never)
    const socket = new FakeSocket()
    handler!(socket)
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify(principal), { status: 200 })) as unknown as typeof fetch
    try {
      socket.emit("message", JSON.stringify({ id: 1, method: "genio/runtime/start", params: { accessToken: "token" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).method === "genio/codexReady"))
      socket.emit("message", JSON.stringify({ id: 2, method: "genio/bot/select", params: { botId: "bot-dylan" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).id === 2))
      socket.emit("message", JSON.stringify({
        id: 3,
        method: "thread/resume",
        params: { threadId: "thread-dylan", environments: [{ environmentId: "headless-environment", cwd: "/etc", runtimeWorkspaceRoots: ["/etc"] }] },
      }))
      await waitFor(() => context.runtimeMessages.some((message) => message.id === 3))
      const forwarded = context.runtimeMessages.find((message) => message.id === 3) as { params: Record<string, any> }
      expect(forwarded.params.environments).toBeUndefined()
      expect(forwarded.params.cwd).toBe("/workspace/headless")
      expect(forwarded.params.runtimeWorkspaceRoots).toEqual(["/workspace/headless"])
      expect(forwarded.params.config["features.shell_tool"]).toBe(true)
      expect(forwarded.params.config["features.unified_exec"]).toBe(true)
      expect(forwarded.params.sandbox).toBe("workspace-write")
      expect(calls.some((call) => call.capability_id === "shell.exec" && call.action === "execute" && call.decision === "ALLOW")).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
      socket.close()
    }
  })

  test.each([
    ["null", null],
    ["number", 42],
    ["string", "headless-environment"],
    ["array", []],
    ["empty object", {}],
    ["non-string id", { environmentId: 42 }],
  ] as const)("rejects a %s runtime environment descriptor before native forwarding", async (_label, descriptor) => {
    const calls: Array<Record<string, unknown>> = []
    const reports: Array<Record<string, unknown>> = []
    const context = createContext(calls, reports)
    activateDesktop(context)
    let handler: ((socket: FakeSocket) => void) | null = null
    await codexRoutes({ get: (_path: string, _options: unknown, next: (socket: FakeSocket) => void) => { handler = next } } as never, context as never)
    const socket = new FakeSocket()
    handler!(socket)
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify(principal), { status: 200 })) as unknown as typeof fetch
    try {
      socket.emit("message", JSON.stringify({ id: 1, method: "genio/runtime/start", params: { accessToken: "token" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).method === "genio/codexReady"))
      socket.emit("message", JSON.stringify({ id: 2, method: "genio/bot/select", params: { botId: "bot-dylan" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).id === 2))
      socket.emit("message", JSON.stringify({ id: 3, method: "thread/resume", params: { threadId: "thread-dylan", environments: [descriptor] } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).id === 3 && JSON.parse(line).error?.code))
      const error = socket.sent.map((line) => JSON.parse(line)).find((message) => message.id === 3)
      expect(error.error.code).toBe("RUNTIME_ENVIRONMENT_NOT_OWNED")
      expect(context.runtimeMessages.some((message) => message.id === 3)).toBe(false)
      expect(calls.some((call) => call.capability_id === "shell.exec" && call.action === "execute")).toBe(false)
      expect(socket.closeCode).toBeNull()
    } finally {
      globalThis.fetch = originalFetch
      socket.close()
    }
  })

  test.each([
    ["omitted", {}],
    ["empty", { environments: [] }],
  ] as const)("clears a prior desktop environment before a %s turn", async (_intent, override) => {
    const calls: Array<Record<string, unknown>> = []
    const reports: Array<Record<string, unknown>> = []
    const context = createContext(calls, reports)
    const { local, desktop } = activateDesktop(context)
    let handler: ((socket: FakeSocket) => void) | null = null
    await codexRoutes({ get: (_path: string, _options: unknown, next: (socket: FakeSocket) => void) => { handler = next } } as never, context as never)
    const socket = new FakeSocket()
    handler!(socket)
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify(principal), { status: 200 })) as unknown as typeof fetch
    try {
      socket.emit("message", JSON.stringify({ id: 1, method: "genio/runtime/start", params: { accessToken: "token" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).method === "genio/codexReady"))
      socket.emit("message", JSON.stringify({ id: 2, method: "genio/bot/select", params: { botId: "bot-dylan" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).id === 2))
      socket.emit("message", JSON.stringify({ id: 3, method: "thread/start", params: { environments: [{ environmentId: desktop.environmentId, cwd: "/etc", runtimeWorkspaceRoots: ["/etc"] }] } }))
      await waitFor(() => context.runtimeMessages.some((message) => message.id === 3))
      const shellAuthorizations = calls.filter((call) => call.capability_id === "shell.exec" && call.action === "execute").length
      expect(shellAuthorizations).toBe(1)
      socket.emit("message", JSON.stringify({ id: 4, method: "turn/start", params: { threadId: "thread-dylan", input: [{ type: "text", text: "Continue" }], ...override } }))
      await waitFor(() => context.runtimeMessages.some((message) => message.id === 4))
      const forwarded = context.runtimeMessages.find((message) => message.id === 4) as { params: Record<string, any> }
      expect(forwarded.params.environments).toEqual([])
      expect(forwarded.params.cwd).toBe(local.cwd)
      expect(forwarded.params.runtimeWorkspaceRoots).toEqual([])
      expect(forwarded.params.sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false })
      expect(calls.filter((call) => call.capability_id === "shell.exec" && call.action === "execute")).toHaveLength(shellAuthorizations)
    } finally {
      globalThis.fetch = originalFetch
      socket.close()
    }
  })

  test("rejects unsupported RPCs and bootstrap queued execution messages", async () => {
    const calls: Array<Record<string, unknown>> = []
    const reports: Array<Record<string, unknown>> = []
    const context = createContext(calls, reports)
    let handler: ((socket: FakeSocket) => void) | null = null
    await codexRoutes({ get: (_path: string, _options: unknown, next: (socket: FakeSocket) => void) => { handler = next } } as never, context as never)
    const beforeStart = new FakeSocket()
    handler!(beforeStart)
    beforeStart.emit("message", JSON.stringify({ id: 7, method: "thread/delete", params: { threadId: "foreign-thread" } }))
    expect(beforeStart.closeCode).toBe(1008)
    expect(beforeStart.closeReason).toBe("RUNTIME_BOOTSTRAP_METHOD_FORBIDDEN")

    const socket = new FakeSocket()
    handler!(socket)
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify(principal), { status: 200 })) as unknown as typeof fetch
    try {
      socket.emit("message", JSON.stringify({ id: 1, method: "genio/runtime/start", params: { accessToken: "token" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).method === "genio/codexReady"))
      socket.emit("message", JSON.stringify({ id: 8, method: "thread/delete", params: { threadId: "thread-dylan" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).id === 8 && JSON.parse(line).error?.code))
      expect(context.runtimeMessages.some((message) => message.id === 8)).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
      socket.close()
    }
  })

  test("rejects a malformed runtime token refresh instead of forwarding it", async () => {
    const calls: Array<Record<string, unknown>> = []
    const reports: Array<Record<string, unknown>> = []
    const context = createContext(calls, reports)
    let handler: ((socket: FakeSocket) => void) | null = null
    await codexRoutes({ get: (_path: string, _options: unknown, next: (socket: FakeSocket) => void) => { handler = next } } as never, context as never)
    const socket = new FakeSocket()
    handler!(socket)
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify(principal), { status: 200 })) as unknown as typeof fetch
    try {
      socket.emit("message", JSON.stringify({ id: 1, method: "genio/runtime/start", params: { accessToken: "token" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).method === "genio/codexReady"))
      socket.emit("message", JSON.stringify({ id: 9, method: "genio/runtime/start", params: { accessToken: 42 } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).id === 9 && JSON.parse(line).error?.code))
      expect(socket.sent.map((line) => JSON.parse(line)).find((message) => message.id === 9)?.error.code).toBe("GENIO_ONE_SESSION_TOKEN_REQUIRED")
      expect(context.runtimeMessages.some((message) => message.id === 9)).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
      socket.close()
    }
  })

  test("keeps a same-principal browser reauth token on the running Runtime Broker session", async () => {
    const calls: Array<Record<string, unknown>> = []
    const reports: Array<Record<string, unknown>> = []
    const context = createContext(calls, reports)
    let handler: ((socket: FakeSocket) => void) | null = null
    await codexRoutes({ get: (_path: string, _options: unknown, next: (socket: FakeSocket) => void) => { handler = next } } as never, context as never)
    const socket = new FakeSocket()
    handler!(socket)
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify(principal), { status: 200 })) as unknown as typeof fetch
    try {
      socket.emit("message", JSON.stringify({ id: 1, method: "genio/runtime/start", params: { accessToken: "first-token" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).method === "genio/codexReady"))
      socket.emit("message", JSON.stringify({ id: 2, method: "genio/runtime/start", params: { accessToken: "refreshed-token" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).id === 2))
      expect(context.session.accessToken).toBe("refreshed-token")
      expect(context.runtimeMessages.some((message) => message.id === 2)).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
      socket.close()
    }
  })

  test("allows thread/realtime/start and forwards thread/realtime/sdp notification to client", async () => {
    const calls: Array<Record<string, unknown>> = []
    const reports: Array<Record<string, unknown>> = []
    const context = createContext(calls, reports)
    context.botRegistry.rememberThread("bot-dylan", "thread-realtime-1")
    let handler: ((socket: FakeSocket) => void) | null = null
    await codexRoutes({ get: (_path: string, _options: unknown, next: (socket: FakeSocket) => void) => { handler = next } } as never, context as never)
    const socket = new FakeSocket()
    handler!(socket)
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify(principal), { status: 200 })) as unknown as typeof fetch
    try {
      socket.emit("message", JSON.stringify({ id: 1, method: "genio/runtime/start", params: { accessToken: "token" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).method === "genio/codexReady"))
      socket.emit("message", JSON.stringify({ id: 2, method: "genio/bot/select", params: { botId: "bot-dylan" } }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).id === 2))

      socket.emit("message", JSON.stringify({
        id: 3,
        method: "thread/realtime/start",
        params: {
          threadId: "thread-realtime-1",
          outputModality: "audio",
          transport: { type: "webrtc", sdp: "v=0\r\no=mock 1 1 IN IP4 127.0.0.1" },
        },
      }))
      await waitFor(() => context.runtimeMessages.some((message) => message.id === 3))
      const forwarded = context.runtimeMessages.find((message) => message.id === 3) as { method: string; params: { threadId: string } }
      expect(forwarded.method).toBe("thread/realtime/start")
      expect(forwarded.params.threadId).toBe("thread-realtime-1")

      context.getCallbacks()?.onMessage(JSON.stringify({
        method: "thread/realtime/sdp",
        params: { threadId: "thread-realtime-1", sdp: "v=0\r\no=server 1 1 IN IP4 127.0.0.1" },
      }))
      await waitFor(() => socket.sent.some((line) => JSON.parse(line).method === "thread/realtime/sdp"))
      const sdpMessage = socket.sent.map((line) => JSON.parse(line)).find((m) => m.method === "thread/realtime/sdp")
      expect(sdpMessage.params.sdp).toContain("o=server")
    } finally {
      globalThis.fetch = originalFetch
      socket.close()
    }
  })
})
