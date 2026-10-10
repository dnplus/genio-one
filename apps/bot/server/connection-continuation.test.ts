import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { BotRegistry } from "./bot-registry"
import { BotToolSessions } from "./bot-tool-sessions"
import { createCapabilityGate } from "./capability-gate"
import { continuePersonalConnections } from "./connection-continuation"
import type { BotServerContext } from "./context"
import type { Turn } from "./generated/v2/Turn"
import { connectionReadOnlyMcpRequest } from "./model-gateway-relay"
import type { RuntimeDetails } from "./runtime"
import { RuntimeBroker } from "./runtime-broker"

const principal = { tenant_id: "connection-continuation", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }

function runtimeDecision(botId: string, capabilityId: string, action: string) {
  return {
    tenant_id: principal.tenant_id,
    subject_id: principal.subject_id,
    client_id: principal.acting_client_id,
    bot_id: botId,
    runtime_id: "codex",
    policy_id: "runtime-policy",
    policy_display_name: "Runtime policy",
    policy_revision: 1,
    capability_id: capabilityId,
    action,
    target: `runtime:codex:${capabilityId}`,
    decision: "ALLOW" as const,
    reason_code: "RULE_ALLOW",
    constraints: [],
    obligations: [],
    correlation_id: `continuation:${capabilityId}:${action}`,
    session_id: "runtime-session",
    evaluated_at: 1_757_000_000,
  }
}

async function fixture(input: { bindings?: Array<{ resourceId: string; capabilityId: string; state: "INSTALLED"; kind: "MCP" }>; startFailures?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "connection-continuation-"))
  const registry = new BotRegistry(":memory:", join(directory, "artifacts"))
  const bot = registry.create(principal, {
    name: "Weekly brief",
    bindings: input.bindings ?? [{ resourceId: "notion", capabilityId: "notion.search", state: "INSTALLED", kind: "MCP" }],
  })
  registry.rememberThread(bot.id, "thread")
  registry.timeline.putTurn(bot.id, "thread", { id: "source-turn", status: "completed", items: [] } as unknown as Turn)
  registry.connectionContinuations.enqueue({
    requestToken: "connection-request",
    botId: bot.id,
    tenantId: principal.tenant_id,
    ownerSubjectId: principal.subject_id,
    sourceThreadId: "thread",
    sourceTurnId: "source-turn",
    resourceId: "notion",
    resourceName: "Notion",
    capabilityId: "notion.search",
  })
  const requests: Array<{ method: string; params: Record<string, unknown> }> = []
  let mcpReady = false
  let mcpToolsError: string | null = null
  let startFailures = input.startFailures ?? 0
  let starts = 0
  const broker = new RuntimeBroker({ provision: async () => { throw new Error("UNUSED") } })
  broker.observe((owner, line) => registry.recordRuntimeEvent(owner, line))
  const session = await broker.start(principal, { onMessage() {}, onExit() {} }, (callbacks) => ({
    async send(line) {
      const request = JSON.parse(line) as { id: number; method: string; params: Record<string, unknown> }
      requests.push({ method: request.method, params: request.params })
      if (request.method === "config/read") {
        callbacks.onMessage(JSON.stringify({ id: request.id, result: { layers: [{ name: { type: "user" }, version: "sha256:one", config: { mcp_servers: {} } }] } }))
        return
      }
      if (request.method === "config/value/write" || request.method === "config/mcpServer/reload") {
        callbacks.onMessage(JSON.stringify({ id: request.id, result: {} }))
        return
      }
      if (request.method === "thread/read") {
        callbacks.onMessage(JSON.stringify({ id: request.id, result: { thread: { id: "thread", status: { type: "idle" } } } }))
        return
      }
      if (request.method === "thread/resume") {
        const config = request.params.config as Record<string, Record<string, unknown>>
        expect(config["mcp_servers.genio_mcp_notion"]?.default_tools_approval_mode).toBe("writes")
        callbacks.onMessage(JSON.stringify({ id: request.id, result: { thread: { id: "thread" } } }))
        return
      }
      if (request.method === "mcpServerStatus/list") {
        callbacks.onMessage(JSON.stringify({ id: request.id, result: { data: [{ name: "genio_mcp_notion", runtimeStatus: mcpReady ? "connected" : "starting", toolsError: mcpToolsError }] } }))
        return
      }
      if (request.method === "turn/start") {
        starts += 1
        if (startFailures > 0) {
          startFailures -= 1
          throw new Error("CONNECTION_CONTINUATION_START_UNCERTAIN")
        }
        expect(request.params.clientUserMessageId).toBe("connection-resume:connection-request")
        expect((request.params.input as Array<{ text: string }>)[0]?.text).toContain("approved read-only Mail2000 and Notion")
        expect((request.params.input as Array<{ text: string }>)[0]?.text).toContain("explicit confirmation")
        callbacks.onMessage(JSON.stringify({ id: request.id, result: { turn: { id: "continued-turn", status: "inProgress" } } }))
        return
      }
      if (request.method === "thread/turns/list") {
        callbacks.onMessage(JSON.stringify({ id: request.id, result: { data: [] } }))
        return
      }
      throw new Error(`unexpected runtime request: ${request.method}`)
    },
    async close() {},
  }), "access-token")
  session.initialized = true
  const local: RuntimeDetails = { kind: "local", tier: "none", cwd: "/local/bot", desktopUrl: null, sandboxId: null, environmentId: null, execServerUrl: null, execReady: false }
  session.details = local
  session.runtimeDetails = { none: local }
  const context = {
    botRegistry: registry,
    runtimeBroker: broker,
    capabilityGate: createCapabilityGate({ mode: "open" }),
    botToolSessions: new BotToolSessions(),
    runtimePolicy: {
      async read() { return { decisions: [] } },
      async authorize(input: { capabilityId: string; action: string }) { return runtimeDecision(bot.id, input.capabilityId, input.action) },
      async resolve(input: { capabilityId: string; action: string }) { return runtimeDecision(bot.id, input.capabilityId, input.action) },
      async report() {},
    },
    modelDirectory: { async resolve() { return [{ publicModelId: "*", displayName: "Codex", route: { kind: "codex-subscription" } }] } },
  } as unknown as BotServerContext
  return {
    registry,
    directory,
    bot,
    broker,
    context,
    requests,
    starts: () => starts,
    setMcpReady: (value: boolean) => { mcpReady = value },
    setMcpToolsError: (value: string | null) => { mcpToolsError = value },
  }
}

async function withMcpEnvironment(run: () => Promise<void>) {
  const originalUrl = process.env.GENIO_ONE_MCP_URL
  const originalRelay = process.env.GENIO_ONE_MCP_RELAY_ORIGIN
  const originalFetch = globalThis.fetch
  process.env.GENIO_ONE_MCP_URL = "http://one.localhost:1975/mcp"
  process.env.GENIO_ONE_MCP_RELAY_ORIGIN = "https://bot.example.test"
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (new URL(String(input)).pathname.endsWith("/catalog")) return Response.json({ capabilities: [
      { resource_id: "notion", capability_id: "notion.search", access: "ENTITLED", publication_endpoint: { hostname: "notion.stellar-freight.localhost", base_path: "/mcp" } },
      { resource_id: "mail2000", capability_id: "mail2000.search", access: "ENTITLED", publication_endpoint: { hostname: "mail2000.stellar-freight.localhost", base_path: "/mcp" } },
      { resource_id: "third-resource", capability_id: "third.search", access: "ENTITLED", publication_endpoint: { hostname: "third.stellar-freight.localhost", base_path: "/mcp" } },
    ] })
    throw new Error(`unexpected fetch: ${String(input)}`)
  }) as typeof fetch
  try {
    await run()
  } finally {
    globalThis.fetch = originalFetch
    if (originalUrl === undefined) delete process.env.GENIO_ONE_MCP_URL
    else process.env.GENIO_ONE_MCP_URL = originalUrl
    if (originalRelay === undefined) delete process.env.GENIO_ONE_MCP_RELAY_ORIGIN
    else process.env.GENIO_ONE_MCP_RELAY_ORIGIN = originalRelay
  }
}

test("waits for the reloaded MCP to become connected before starting one read-only continuation", async () => {
  await withMcpEnvironment(async () => {
    const value = await fixture()
    try {
      await continuePersonalConnections(value.context)
      expect(value.starts()).toBe(0)
      expect(value.registry.connectionContinuations.get("connection-request")).toMatchObject({ state: "awaiting_mcp", serverNames: ["genio_mcp_notion"] })
      value.setMcpReady(true)
      await continuePersonalConnections(value.context)
      await continuePersonalConnections(value.context)
      expect(value.starts()).toBe(1)
      expect(value.registry.connectionContinuations.get("connection-request")).toMatchObject({ state: "running", continuationThreadId: "thread", continuationTurnId: "continued-turn" })
    } finally {
      await value.broker.stop(value.broker.findByPrincipal(principal)!.id)
      value.registry.close()
      rmSync(value.directory, { recursive: true, force: true })
    }
  })
})

test("cancels a queued continuation when a later turn supersedes its source", async () => {
  const value = await fixture()
  try {
    value.registry.timeline.putTurn(value.bot.id, "thread", { id: "later-turn", status: "inProgress", items: [] } as unknown as Turn)
    await continuePersonalConnections(value.context)
    expect(value.requests).toEqual([])
    expect(value.starts()).toBe(0)
    expect(value.registry.connectionContinuations.get("connection-request")).toMatchObject({ state: "cancelled", error: "CONNECTION_SOURCE_SUPERSEDED" })
  } finally {
    await value.broker.stop(value.broker.findByPrincipal(principal)!.id)
    value.registry.close()
    rmSync(value.directory, { recursive: true, force: true })
  }
})

test("defers a queued continuation while its source turn is still in progress", async () => {
  const value = await fixture()
  try {
    value.registry.timeline.putTurn(value.bot.id, "thread", { id: "source-turn", status: "inProgress", items: [] } as unknown as Turn)
    await continuePersonalConnections(value.context)
    expect(value.requests).toEqual([])
    expect(value.registry.connectionContinuations.get("connection-request")).toMatchObject({ state: "queued" })
  } finally {
    await value.broker.stop(value.broker.findByPrincipal(principal)!.id)
    value.registry.close()
    rmSync(value.directory, { recursive: true, force: true })
  }
})

test("mounts only approved Mail2000 and Notion resources", async () => {
  await withMcpEnvironment(async () => {
    const value = await fixture({ bindings: [
      { resourceId: "notion", capabilityId: "notion.search", state: "INSTALLED", kind: "MCP" },
      { resourceId: "mail2000", capabilityId: "mail2000.search", state: "INSTALLED", kind: "MCP" },
      { resourceId: "third-resource", capabilityId: "third.search", state: "INSTALLED", kind: "MCP" },
    ] })
    try {
      await continuePersonalConnections(value.context)
      const write = value.requests.find((request) => request.method === "config/value/write")
      const servers = write?.params.value as Record<string, unknown>
      expect(Object.keys(servers).sort()).toEqual(["genio_mcp_mail2000", "genio_mcp_notion"])
    } finally {
      await value.broker.stop(value.broker.findByPrincipal(principal)!.id)
      value.registry.close()
      rmSync(value.directory, { recursive: true, force: true })
    }
  })
})

test("treats connected MCP tool discovery failure as unavailable", async () => {
  await withMcpEnvironment(async () => {
    const value = await fixture()
    try {
      await continuePersonalConnections(value.context)
      value.setMcpReady(true)
      value.setMcpToolsError("catalog failed")
      await continuePersonalConnections(value.context)
      expect(value.starts()).toBe(0)
      expect(value.registry.connectionContinuations.get("connection-request")).toMatchObject({ state: "failed", error: "MANAGED_MCP_UNAVAILABLE" })
    } finally {
      await value.broker.stop(value.broker.findByPrincipal(principal)!.id)
      value.registry.close()
      rmSync(value.directory, { recursive: true, force: true })
    }
  })
})

test("reconciles an uncertain start before retrying the same client ID", async () => {
  await withMcpEnvironment(async () => {
    const value = await fixture({ startFailures: 1 })
    try {
      await continuePersonalConnections(value.context)
      value.setMcpReady(true)
      await continuePersonalConnections(value.context)
      expect(value.registry.connectionContinuations.get("connection-request")).toMatchObject({ state: "starting" })
      await continuePersonalConnections(value.context)
      expect(value.registry.connectionContinuations.get("connection-request")).toMatchObject({ state: "retrying" })
      await continuePersonalConnections(value.context)
      expect(value.starts()).toBe(2)
      expect(value.registry.connectionContinuations.get("connection-request")).toMatchObject({ state: "running", continuationTurnId: "continued-turn" })
    } finally {
      await value.broker.stop(value.broker.findByPrincipal(principal)!.id)
      value.registry.close()
      rmSync(value.directory, { recursive: true, force: true })
    }
  })
})

test("keeps the write guard after a source supersedes an ambiguous continuation", async () => {
  await withMcpEnvironment(async () => {
    const value = await fixture({ startFailures: 1 })
    try {
      await continuePersonalConnections(value.context)
      value.setMcpReady(true)
      await continuePersonalConnections(value.context)
      await continuePersonalConnections(value.context)
      value.registry.timeline.putTurn(value.bot.id, "thread", { id: "later-turn", status: "inProgress", items: [] } as unknown as Turn)
      await continuePersonalConnections(value.context)
      expect(value.registry.connectionContinuations.get("connection-request")).toMatchObject({ state: "guarded", error: "CONNECTION_SOURCE_SUPERSEDED" })
      expect(value.registry.connectionContinuations.isReadOnlyBotTurn(value.bot.id)).toBe(true)
    } finally {
      await value.broker.stop(value.broker.findByPrincipal(principal)!.id)
      value.registry.close()
      rmSync(value.directory, { recursive: true, force: true })
    }
  })
})

test("releases a guarded continuation after its native runtime exits", async () => {
  await withMcpEnvironment(async () => {
    const value = await fixture({ startFailures: 1 })
    const runtimeSessionId = value.broker.findByPrincipal(principal)!.id
    try {
      await continuePersonalConnections(value.context)
      value.setMcpReady(true)
      await continuePersonalConnections(value.context)
      await continuePersonalConnections(value.context)
      value.registry.timeline.putTurn(value.bot.id, "thread", { id: "later-turn", status: "inProgress", items: [] } as unknown as Turn)
      await continuePersonalConnections(value.context)
      expect(value.registry.connectionContinuations.get("connection-request")).toMatchObject({ state: "guarded" })
      await value.broker.stop(runtimeSessionId)
      await continuePersonalConnections(value.context)
      expect(value.registry.connectionContinuations.get("connection-request")).toMatchObject({ state: "failed", error: "CONNECTION_CONTINUATION_RUNTIME_GONE" })
      expect(value.registry.connectionContinuations.isReadOnlyBotTurn(value.bot.id)).toBe(false)
    } finally {
      await value.broker.stop(runtimeSessionId)
      value.registry.close()
      rmSync(value.directory, { recursive: true, force: true })
    }
  })
})

test("rejects a Notion write even when the upstream tool falsely claims it is read-only", () => {
  const request = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "notion__notion-update-page", annotations: { readOnlyHint: true } },
  }
  expect(connectionReadOnlyMcpRequest({ resourceId: "notion" }, "POST", request)).toBe("CONNECTION_CONTINUATION_MCP_TOOL_NOT_READ_ONLY")
  expect(connectionReadOnlyMcpRequest({ resourceId: "notion" }, "POST", { ...request, params: { name: "notion__notion-fetch" } })).toBeNull()
})

for (const [resourceId, tool, allowed] of [
  ["notion", "notion__notion-fetch", true],
  ["mail2000", "mail2000__read_mail", true],
  ["notion", "mail2000__read_mail", false],
  ["mail2000", "notion__notion-fetch", false],
  ["unknown-resource", "notion__notion-fetch", false],
  ["unknown-resource", "mail2000__read_mail", false],
  ["notion", "notion__unknown", false],
  ["mail2000", "mail2000__unknown", false],
  ["notion", "notion-fetch", false],
  ["mail2000", "read_mail", false],
] as const) {
  test(`read-only continuation ${allowed ? "allows" : "rejects"} ${resourceId} with ${tool}`, () => {
    const body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, annotations: { readOnlyHint: true } } }
    expect(connectionReadOnlyMcpRequest({ resourceId }, "POST", body)).toBe(allowed ? null : "CONNECTION_CONTINUATION_MCP_TOOL_NOT_READ_ONLY")
  })
}

test("continuation rejects malformed request bodies and HTTP methods before selecting a tool", () => {
  const entry = { resourceId: "mail2000" }
  const validBody = { method: "tools/call", params: { name: "mail2000__read_mail" } }
  for (const method of ["GET", "post", undefined, 1]) {
    expect(connectionReadOnlyMcpRequest(entry, method, validBody)).toBe("CONNECTION_CONTINUATION_MCP_REQUEST_NOT_ALLOWED")
  }
  for (const body of [undefined, null, "tools/call", [], [validBody]]) {
    expect(connectionReadOnlyMcpRequest(entry, "POST", body)).toBe("CONNECTION_CONTINUATION_MCP_REQUEST_NOT_ALLOWED")
  }
})

test("continuation rejects unsupported RPC methods and malformed tool selectors", () => {
  const entry = { resourceId: "notion" }
  for (const method of [undefined, "resources/read", "prompts/get", "Tools/Call", 1]) {
    expect(connectionReadOnlyMcpRequest(entry, "POST", { method, params: { name: "notion__notion-fetch" } })).toBe("CONNECTION_CONTINUATION_MCP_METHOD_NOT_ALLOWED")
  }
  for (const params of [undefined, null, "notion__notion-fetch", {}, { name: 1 }, { name: ["notion__notion-fetch"] }]) {
    expect(connectionReadOnlyMcpRequest(entry, "POST", { method: "tools/call", params })).toBe("CONNECTION_CONTINUATION_MCP_TOOL_NOT_READ_ONLY")
  }
})
