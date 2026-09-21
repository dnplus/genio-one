import { afterEach, expect, test } from "bun:test"

import { BotRegistry } from "./bot-registry"
import { botBoundDiscoveryMcpUrl, botBoundModelGatewayBaseUrl } from "./bot-model-config"
import { canonicalizeNativeParams } from "./native-runtime-params"
import type { BotModelDirectory } from "./model-directory"
import type { RuntimeSession } from "./runtime-broker"

const originalRelayOrigin = process.env.GENIO_ONE_MODEL_GATEWAY_RELAY_ORIGIN
const originalBotPort = process.env.GENIO_BOT_PORT

afterEach(() => {
  if (originalRelayOrigin === undefined) delete process.env.GENIO_ONE_MODEL_GATEWAY_RELAY_ORIGIN
  else process.env.GENIO_ONE_MODEL_GATEWAY_RELAY_ORIGIN = originalRelayOrigin
  if (originalBotPort === undefined) delete process.env.GENIO_BOT_PORT
  else process.env.GENIO_BOT_PORT = originalBotPort
})

const principal = {
  tenant_id: "tenant-uat",
  subject_id: "person-dylan",
  acting_client_id: "genio-one-bot",
  organization_ids: ["org-engineering"],
  scopes: ["genioone-invocation"],
}

const modelDirectory: BotModelDirectory = {
  availableRoutes: () => ["genio-gateway"],
  supports: () => true,
  async resolve(_principal, _botId, route) {
    return [{
      publicModelId: "company-model",
      displayName: "Company Model",
      route: route ?? { kind: "genio-gateway", modelProvider: "genio_one" },
    }]
  },
}

function runtimeSession(): RuntimeSession {
  const local = { kind: "local", tier: "none", cwd: "/local/bot", desktopUrl: null, sandboxId: null, environmentId: null, execServerUrl: null, execReady: false }
  const desktop = { kind: "e2b-self-hosted", tier: "desktop", cwd: "/home/user", desktopUrl: "https://desktop.example", sandboxId: "desktop-sandbox", environmentId: "desktop-environment", execServerUrl: "ws://desktop.example", execReady: true }
  const headless = { kind: "e2b-self-hosted", tier: "headless", cwd: "/workspace/headless", desktopUrl: null, sandboxId: "headless-sandbox", environmentId: "headless-environment", execServerUrl: "ws://headless.example", execReady: true }
  return {
    id: "runtime session/a",
    principal,
    details: desktop,
    runtimeDetails: { none: local, desktop, headless },
  } as RuntimeSession
}

test("uses the local Bot relay when no relay origin is configured", () => {
  delete process.env.GENIO_ONE_MODEL_GATEWAY_RELAY_ORIGIN
  process.env.GENIO_BOT_PORT = "5191"
  expect(botBoundModelGatewayBaseUrl("runtime session/a", "bot/a")).toBe(
    "http://127.0.0.1:5191/api/model-gateway/runtime%20session%2Fa/bots/bot%2Fa/v1",
  )
  expect(botBoundDiscoveryMcpUrl("runtime session/a", "bot/a")).toBe(
    "http://127.0.0.1:5191/api/discovery-mcp/runtime%20session%2Fa/bots/bot%2Fa/mcp",
  )
})

test("uses the configured relay origin for a Bot-bound model URL", () => {
  process.env.GENIO_ONE_MODEL_GATEWAY_RELAY_ORIGIN = "https://relay.example/"
  expect(botBoundModelGatewayBaseUrl("runtime-session", "bot-a")).toBe(
    "https://relay.example/api/model-gateway/runtime-session/bots/bot-a/v1",
  )
  expect(botBoundDiscoveryMcpUrl("runtime-session", "bot-a")).toBe(
    "https://relay.example/api/discovery-mcp/runtime-session/bots/bot-a/mcp",
  )
})

test.each([
  ["thread/start", { model: "company-model" }],
  ["thread/resume", { threadId: "thread-a", model: "company-model", environments: [{ environmentId: "headless-environment" }] }],
  ["turn/start", { threadId: "thread-a", model: "company-model", input: [{ type: "text", text: "Continue" }] }],
] as const)("%s supplies a server-owned Bot relay config", async (method, params) => {
  process.env.GENIO_ONE_MODEL_GATEWAY_RELAY_ORIGIN = "https://relay.example"
  const registry = new BotRegistry(":memory:")
  try {
    const bot = registry.create(principal, {
      name: "Schedule A",
      modelRoute: "genio-gateway",
      ownerOrganizationId: "org-engineering",
      useCaseId: "purpose-a",
    })
    const result = await canonicalizeNativeParams({
      method,
      params,
      session: runtimeSession(),
      botId: bot.id,
      exposure: { shell: method === "thread/resume", filesystemRead: method === "thread/resume", filesystemWrite: false, browser: false, webSearch: false },
      environment: { hasRuntimeEnvironment: method === "thread/resume", hasDesktopRuntime: false },
      botRegistry: registry,
      modelDirectory,
      accessToken: "session-token",
    })
    if (method === "turn/start") {
      expect(result).toMatchObject({
        model: "company-model",
        modelProvider: "genio_one",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      })
    } else {
      expect(result).toMatchObject({
        model: "company-model",
        modelProvider: "genio_one",
        config: {
          "mcp_servers.genio_discovery": {
            url: `https://relay.example/api/discovery-mcp/${encodeURIComponent("runtime session/a")}/bots/${encodeURIComponent(bot.id)}/mcp`,
          },
          "model_providers.genio_one.base_url": `https://relay.example/api/model-gateway/${encodeURIComponent("runtime session/a")}/bots/${encodeURIComponent(bot.id)}/v1`,
        },
      })
    }
    if (method === "thread/resume") expect(result.environments).toBeUndefined()
    else expect(result.environments).toEqual([])
    if (method === "thread/resume") {
      expect(result.threadId).toBe("thread-a")
      expect(result.cwd).toBe("/workspace/headless")
      expect(result.runtimeWorkspaceRoots).toEqual(["/workspace/headless"])
      expect((result.config as Record<string, unknown>)["features.shell_tool"]).toBe(true)
    } else {
      expect(result.cwd).toBe("/local/bot")
      expect(result.runtimeWorkspaceRoots).toEqual([])
    }
  } finally {
    registry.close()
  }
})

test("fails closed when an active native lease has no local runtime context", async () => {
  const registry = new BotRegistry(":memory:")
  try {
    const bot = registry.create(principal, {
      name: "Schedule A",
      modelRoute: "genio-gateway",
      ownerOrganizationId: "org-engineering",
      useCaseId: "purpose-a",
    })
    const session = runtimeSession()
    delete session.runtimeDetails.none
    await expect(canonicalizeNativeParams({
      method: "thread/start",
      params: { model: "company-model" },
      session,
      botId: bot.id,
      exposure: { shell: false, filesystemRead: false, filesystemWrite: false, browser: false, webSearch: false },
      environment: { hasRuntimeEnvironment: false, hasDesktopRuntime: false },
      botRegistry: registry,
      modelDirectory,
      accessToken: "session-token",
    })).rejects.toThrow("RUNTIME_LOCAL_CONTEXT_UNAVAILABLE")
  } finally {
    registry.close()
  }
})
