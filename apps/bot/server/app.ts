import { registerBrowserTelemetry } from "@genioone/telemetry/browser-telemetry-http"
import { requestPrincipal } from "./auth"
import { instrumentModuleGraph } from "@genioone/telemetry/operation-observability"
import { registerHttpObservability } from "@genioone/telemetry/fastify-observability"
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
import { BotWorkspaceStore } from "./bot-workspace-store"
import { HandsPlacementGate } from "./hands-placement-gate"
import { createBotModelDirectory } from "./model-directory"
import { createManagedDesktop } from "./runtime"
import { RuntimeBroker } from "./runtime-broker"
import type { BotServerContext } from "./context"

import { healthRoutes } from "./routes/health"
import { proxyRoutes } from "./routes/proxy"
import { botRoutes } from "./routes/bots"
import { artifactRoutes } from "./routes/artifacts"
import { workspaceRoutes } from "./routes/workspaces"
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
import { botDefaultToolRoutes } from "./routes/bot-default-tools"
import { knowledgeEvidenceRoutes } from "./routes/knowledge-evidence"
import { BotSchedules } from "./bot-schedules"
import { runBotSchedules } from "./bot-schedule-runner"
import { backfillDistillationTurn } from "./distillation/backfill"
import { SQLiteDistillationBackfillProgressStore } from "./distillation/backfill-progress"
import { turnReady } from "./distillation/history"
import { attachDistillation } from "./distillation/worker"
import { BotDeletionReconciler } from "./bot-deletion-reconciler"

export async function createBotApp(
  contextOverrides?: Partial<BotServerContext>,
  options?: { logger?: boolean },
): Promise<FastifyInstance> {
  const app = Fastify({ logger: options?.logger ?? false })
  registerHttpObservability(app, "genio-one-bot")
  await app.register(websocket)

  const botRegistry = contextOverrides?.botRegistry ?? new BotRegistry()
  const workspaces = contextOverrides?.workspaces ?? new BotWorkspaceStore(botRegistry.db, (botId, principal) => botRegistry.getOwned(botId, principal))
  const distillationBackfillProgress = new SQLiteDistillationBackfillProgressStore(botRegistry.db)
  const capabilityGate = contextOverrides?.capabilityGate ?? createCapabilityGate()
  const modelDirectory = contextOverrides?.modelDirectory ?? createBotModelDirectory()
  const runtimePolicy = contextOverrides?.runtimePolicy ?? createRuntimePolicyClient()
  const handsPlacement = contextOverrides?.handsPlacement ?? new HandsPlacementGate(runtimePolicy, workspaces)
  const runtimeBroker = contextOverrides?.runtimeBroker ?? new RuntimeBroker({ provision: (request, callbacks) => createManagedDesktop(request, callbacks, workspaces) }, 600_000, workspaces, handsPlacement)
  const distillation = attachDistillation({
    registry: botRegistry,
    sessions: {
      tokenFor(principal, _botId) {
        const session = runtimeBroker.findByPrincipal(principal)
        if (!session?.initialized) return null
        const token = session.accessToken?.trim()
        return token || null
      },
      claimTargets() {
        return runtimeBroker.activeSessionPrincipals().flatMap((principal) =>
          botRegistry.ownedBotIds(principal).map((botId) => ({ principal, botId })),
        )
      },
      backfill({ principal, botId, threadId, turnId, turnIds, progressKey }) {
        const session = runtimeBroker.findByPrincipal(principal)
        const progress = distillationBackfillProgress.forTurn(botId, threadId, progressKey ?? turnId)
        const targetTurnIds = turnIds?.length ? turnIds : [turnId]
        if (!session?.initialized) return Promise.resolve({ status: "TRANSIENT_FAILURE" as const, exhaustedScans: progress.exhaustedScans() })
        return backfillDistillationTurn({
          request: (method, params) => runtimeBroker.request(session.id, method, params),
          importTurns: (turns, revision) => botRegistry.importRuntimeHistory(botId, threadId, turns, revision),
          readRevision: () => botRegistry.timeline.revision(),
          threadId,
          turnId,
          ready: () => targetTurnIds.every((targetTurnId) =>
            turnReady(botRegistry.timeline.storedTurn(botId, threadId, targetTurnId)?.turn ?? null),
          ),
          progress,
        }).catch(() => ({ status: "TRANSIENT_FAILURE" as const, exhaustedScans: progress.exhaustedScans() }))
      },
    },
  })
  const stopObserving = runtimeBroker.observe((principal, line, runtimeId) => {
    botRegistry.recordRuntimeEvent(principal, line, runtimeId)
    distillation.note(principal, line)
  })
  app.addHook("onClose", async () => { distillation.stop(); stopObserving() })

  const botSchedules = contextOverrides?.botSchedules ?? new BotSchedules(botRegistry.db)
  const botDeletionReconciler = new BotDeletionReconciler(botRegistry, botSchedules, runtimeBroker, workspaces)
  const context: BotServerContext = {
    botToolSessions: contextOverrides?.botToolSessions ?? new BotToolSessions(),
    botRegistry,
    workspaces,
    handsPlacement,
    capabilityGate,
    modelDirectory,
    runtimeBroker,
    createCodexRuntime: contextOverrides?.createCodexRuntime,
    runtimePolicy,
    botSchedules,
    botDeletionReconciler,
  }
  instrumentModuleGraph(context as unknown as Record<string, unknown>, "genio-one-bot")
  const scheduleRunner = runBotSchedules(context)
  void botDeletionReconciler.reconcile()
  context.localHands = new LocalHands(context)
  app.addHook("preClose", async () => {
    scheduleRunner.stop()
    await context.localHands?.close()
    await runtimeBroker.close()
  })
  reconcileTerminalInvocations(botRegistry)
  const continuationTimer = setInterval(() => {
    try { reconcileTerminalInvocations(botRegistry) }
    catch { console.warn(JSON.stringify({ event: "bot.invocation.recovery_deferred" })) }
    void deliverQuestionAnswers(context)
    void continueCallers(context)
    void recoverApprovedInvocations(context)
    void recoverNativeInvocationResults(context)
    void botDeletionReconciler.reconcile()
  }, 2000)
  continuationTimer.unref()
  app.addHook("onClose", async () => { clearInterval(continuationTimer) })

  await transcriptionRoutes(app)
  await localHandsRoutes(app, context)
  registerBrowserTelemetry(app, { path: "/api/browser-telemetry", service: "genio-one-bot-web", principal: requestPrincipal })
  await healthRoutes(app, context)
  await botQuestionRoutes(app, context)
  await botToolRoutes(app, context)
  await botDefaultToolRoutes(app, context)
  await knowledgeEvidenceRoutes(app, context)
  await botMemoryRoutes(app, context)
  await proxyRoutes(app, context)
  await botRoutes(app, context)
  await artifactRoutes(app, context)
  await workspaceRoutes(app, context)
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
