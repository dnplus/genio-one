import { registerBrowserTelemetry } from "../../../packages/telemetry/src/browser-telemetry-http"
import { requestPrincipal } from "./auth"
import { instrumentModuleGraph } from "../../../packages/telemetry/src/operation-observability"
import { registerHttpObservability } from "../../../packages/telemetry/src/fastify-observability"
import { transcriptionRoutes } from "./routes/transcription"
import { LocalHands, localHandsRoutes } from "./local-hands"
import { deliverQuestionAnswers } from "./question-delivery"
import { botQuestionRoutes } from "./routes/bot-questions"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import fastifyStatic from "@fastify/static"
import websocket from "@fastify/websocket"
import Fastify, { type FastifyInstance } from "fastify"

import { createCapabilityGate } from "./capability-gate"
import { BotRegistry } from "./bot-registry"
import { createBotModelDirectory } from "./model-directory"
import { createManagedDesktop } from "./runtime"
import { RuntimeBroker } from "./runtime-broker"
import type { BotServerContext } from "./context"

import { healthRoutes } from "./routes/health"
import { proxyRoutes } from "./routes/proxy"
import { botRoutes } from "./routes/bots"
import { artifactRoutes } from "./routes/artifacts"
import { catalogRoutes } from "./routes/catalog"
import { ceDemoRoutes } from "./routes/ce-demo"
import { invocationRoutes } from "./routes/invocations"
import { handoffRoutes } from "./routes/handoffs"
import { groupRoutes } from "./routes/groups"
import { codexRoutes } from "./routes/codex"
import { continueCallers } from "./caller-continuation"
import { reconcileTerminalInvocations, recoverApprovedInvocations, recoverNativeInvocationResults } from "./invocation-recovery"
import { BotToolSessions } from "./bot-tool-sessions"
import { botToolRoutes } from "./routes/bot-tools"
import { botMemoryRoutes } from "./routes/bot-memory"
import { modelGatewayRelayRoutes } from "./model-gateway-relay"
import { createRuntimePolicyClient } from "./runtime-policy"

export async function createBotApp(
  contextOverrides?: Partial<BotServerContext>,
  options?: { logger?: boolean },
): Promise<FastifyInstance> {
  const app = Fastify({ logger: options?.logger ?? false })
  registerHttpObservability(app, "genio-one-bot")
  await app.register(websocket)

  const botRegistry = contextOverrides?.botRegistry ?? new BotRegistry()
  const capabilityGate = contextOverrides?.capabilityGate ?? createCapabilityGate()
  const modelDirectory = contextOverrides?.modelDirectory ?? createBotModelDirectory()
  const runtimeBroker = contextOverrides?.runtimeBroker ?? new RuntimeBroker({ provision: createManagedDesktop })
  const runtimePolicy = contextOverrides?.runtimePolicy ?? createRuntimePolicyClient()
  const stopObserving = runtimeBroker.observe((principal, line, runtimeId) => botRegistry.recordRuntimeEvent(principal, line, runtimeId))
  app.addHook("preClose", async () => { await runtimeBroker.close() })
  app.addHook("onClose", async () => { stopObserving() })

  const context: BotServerContext = {
    botToolSessions: contextOverrides?.botToolSessions ?? new BotToolSessions(),
    botRegistry,
    capabilityGate,
    modelDirectory,
    runtimeBroker,
    createCodexRuntime: contextOverrides?.createCodexRuntime,
    runtimePolicy,
  }
  instrumentModuleGraph(context as unknown as Record<string, unknown>, "genio-one-bot")
  context.localHands = new LocalHands(context)
  app.addHook("preClose", async () => { await context.localHands?.close() })
  reconcileTerminalInvocations(botRegistry)
  const continuationTimer = setInterval(() => {
    try { reconcileTerminalInvocations(botRegistry) }
    catch { console.warn(JSON.stringify({ event: "bot.invocation.recovery_deferred" })) }
    void deliverQuestionAnswers(context)
    void continueCallers(context)
    void recoverApprovedInvocations(context)
    void recoverNativeInvocationResults(context)
  }, 2000)
  continuationTimer.unref()
  app.addHook("onClose", async () => { clearInterval(continuationTimer) })

  await transcriptionRoutes(app)
  await localHandsRoutes(app, context)
  registerBrowserTelemetry(app, { path: "/api/browser-telemetry", service: "genio-one-bot-web", principal: requestPrincipal })
  await healthRoutes(app, context)
  await botQuestionRoutes(app, context)
  await botToolRoutes(app, context)
  await botMemoryRoutes(app, context)
  await proxyRoutes(app, context)
  await botRoutes(app, context)
  await artifactRoutes(app, context)
  await catalogRoutes(app, context)
  await ceDemoRoutes(app, context)
  await invocationRoutes(app, context)
  await handoffRoutes(app, context)
  await groupRoutes(app, context)
  await modelGatewayRelayRoutes(app, context)
  await codexRoutes(app, context)

  const webRootCandidates = [
    resolve(import.meta.dir, "../web"),
    resolve(import.meta.dir, "../dist/web"),
    resolve(import.meta.dir, "dist/web"),
  ]
  const webRoot = webRootCandidates.find((dir) => existsSync(dir))
  if (webRoot) {
    await app.register(fastifyStatic, { root: webRoot })
    app.setNotFoundHandler((request, reply) => request.url.startsWith("/api/") || request.method !== "GET"
      ? reply.code(404).send({ error: "NOT_FOUND" })
      : reply.sendFile("index.html"))
  }

  return app
}
