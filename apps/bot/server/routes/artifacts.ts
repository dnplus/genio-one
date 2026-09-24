import { createHash, randomUUID } from "node:crypto"
import { isHandsRelativePath, type HandsProvider } from "@genioone/protocol/hands"
import type { FastifyInstance } from "fastify"
import { requestAccessToken, requestPrincipal } from "../auth"
import type { BotServerContext } from "../context"
import type { GenioPrincipal, RuntimeBroker } from "../runtime-broker"
import { handsBackendFor } from "../hands-provider"
import { assertCapability, PERSONAL_BOT_COMPUTER_USE } from "../capability-gate"

function runtimeLeaseForPrincipal(runtimeBroker: RuntimeBroker, principal: GenioPrincipal, botId: string, tier: "headless" | "desktop", environmentId?: string) {
  const session = runtimeBroker.findByPrincipal(principal)
  const lease = session?.leases[tier]
  if (!session || !lease || !lease.details.execReady) throw new Error("RUNTIME_LEASE_NOT_FOUND")
  if ((lease.details.botId ?? lease.details.endpoint?.botId) !== botId) throw new Error("RUNTIME_WORKSPACE_NOT_OWNED")
  if (environmentId && lease.details.environmentId !== environmentId) throw new Error("RUNTIME_ENVIRONMENT_NOT_OWNED")
  return { session, lease }
}

function relativeArtifactPath(cwd: string, path: string) {
  const prefix = `${cwd.replace(/\/$/, "")}/`
  const relative = path.startsWith(prefix) ? path.slice(prefix.length) : null
  if (!isHandsRelativePath(relative)) throw new Error("ARTIFACT_PATH_INVALID")
  return relative
}

function leaseHandsProvider(kind: string): HandsProvider {
  if (kind === "cloudflare-hands") return "cloudflare-hands"
  if (kind === "e2b-self-hosted" || kind === "endpoint") return "e2b-self-hosted"
  throw new Error("RUNTIME_ARTIFACT_PROVIDER_UNSUPPORTED")
}

export async function artifactRoutes(app: FastifyInstance, context: BotServerContext) {
  const { botRegistry, runtimeBroker } = context

  app.get("/api/bots/:botId/artifacts", async (request, reply) => {
    try {
      return reply.send(botRegistry.listArtifacts(await requestPrincipal(request), (request.params as { botId: string }).botId))
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "BOT_ARTIFACT_LIST_FAILED" })
    }
  })

  app.post("/api/bots/:botId/artifacts", async (request, reply) => {
    try {
      const principal = await requestPrincipal(request)
      const body = request.body as Record<string, unknown>
      const artifact = botRegistry.registerArtifact(principal, {
        botId: (request.params as { botId: string }).botId,
        sourceTier: body.sourceTier as "none" | "headless" | "desktop",
        sourceEnvironmentId: typeof body.sourceEnvironmentId === "string" ? body.sourceEnvironmentId : "",
        path: typeof body.path === "string" ? body.path : "",
        digest: typeof body.digest === "string" ? body.digest : "",
        contentType: typeof body.contentType === "string" ? body.contentType : undefined,
        size: typeof body.size === "number" ? body.size : undefined,
      })
      return reply.code(201).send(artifact)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "BOT_ARTIFACT_REGISTER_FAILED" })
    }
  })

  app.post("/api/bots/:botId/artifacts/from-runtime", async (request, reply) => {
    try {
      const principal = await requestPrincipal(request)
      const accessToken = requestAccessToken(request)
      const body = request.body as Record<string, unknown>
      const botId = (request.params as { botId: string }).botId
      if (!botRegistry.getOwned(botId, principal)) throw new Error("BOT_NOT_FOUND")
      const path = typeof body.path === "string" ? body.path : ""
      if (body.sourceTier === "isolate") {
        const workspaceId = typeof body.sourceWorkspaceId === "string" ? body.sourceWorkspaceId : ""
        const workspace = workspaceId ? context.workspaces.get(principal, botId, workspaceId) : null
        if (!workspace) throw new Error("WORKSPACE_NOT_FOUND")
        const backend = handsBackendFor(workspace.provider)
        if (!backend.supportsJavascript) throw new Error("HANDS_ISOLATE_PROVIDER_UNSUPPORTED")
        const relativePath = relativeArtifactPath("/workspace", path)
        const actor = { principal, botId, accessToken, sessionId: workspaceId }
        const artifact = await context.handsPlacement.run(actor, workspace.provider, () => context.handsPlacement.runCapability(actor, "filesystem.read", "invoke", async () => {
          const captured = await backend.captureCommittedArtifact(workspace, relativePath, `artifact-${randomUUID()}`, principal.acting_client_id)
          return botRegistry.registerArtifact(principal, {
            artifactId: captured.artifactId,
            botId,
            sourceTier: "isolate",
            sourceEnvironmentId: `workspace:${workspaceId}`,
            path,
            digest: captured.digest,
            contentType: typeof body.contentType === "string" ? body.contentType : undefined,
            size: captured.size,
            storageProvider: workspace.provider,
            sourceWorkspaceId: workspaceId,
            sourceRevision: captured.revision,
            storageRef: captured.storageRef,
          })
        }))
        return reply.code(201).send(artifact)
      }
      const tier = body.sourceTier === "desktop" ? "desktop" : body.sourceTier === "headless" ? "headless" : null
      if (!tier) throw new Error("ARTIFACT_RUNTIME_TIER_INVALID")
      const sourceEnvironmentId = typeof body.sourceEnvironmentId === "string" ? body.sourceEnvironmentId.trim() : ""
      if (!sourceEnvironmentId || !path) throw new Error("ARTIFACT_SOURCE_REQUIRED")
      const { session, lease } = runtimeLeaseForPrincipal(runtimeBroker, principal, botId, tier, sourceEnvironmentId)
      const relativePath = relativeArtifactPath(lease.details.cwd, path)
      const backend = handsBackendFor(leaseHandsProvider(lease.details.kind))
      const actor = { principal, botId, accessToken, sessionId: session.id }
      const artifact = await context.handsPlacement.run(actor, backend.provider, () => context.handsPlacement.runCapability(actor, "filesystem.read", "invoke", async () => {
        const captured = await backend.captureArtifact(lease, relativePath, `artifact-${randomUUID()}`)
        if (captured.bytes) botRegistry.storeArtifactBytes(captured.artifactId, captured.bytes)
        return botRegistry.registerArtifact(principal, {
          artifactId: captured.artifactId,
          botId,
          sourceTier: tier,
          sourceEnvironmentId,
          path,
          digest: captured.digest,
          contentType: typeof body.contentType === "string" ? body.contentType : undefined,
          size: captured.size,
          storageProvider: backend.provider,
          sourceWorkspaceId: captured.workspaceId,
          sourceRevision: captured.revision,
          storageRef: captured.storageRef,
        })
      }))
      console.info(JSON.stringify({
        event: "bot.artifact.captured",
        artifact_id: artifact.artifactId,
        tenant_id: artifact.tenantId,
        bot_id: artifact.botId,
        runtime_tier: artifact.sourceTier,
        environment_id: artifact.sourceEnvironmentId,
        digest: artifact.digest,
        size: artifact.size,
        storage_provider: artifact.storageProvider,
        workspace_id: artifact.sourceWorkspaceId,
        workspace_revision: artifact.sourceRevision,
        correlation_id: artifact.artifactId,
      }))
      return reply.code(201).send(artifact)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "BOT_ARTIFACT_CAPTURE_FAILED" })
    }
  })

  app.post("/api/bots/:botId/artifacts/:artifactId/import", async (request, reply) => {
    try {
      const principal = await requestPrincipal(request)
      const accessToken = requestAccessToken(request)
      const params = request.params as { botId: string; artifactId: string }
      const artifact = botRegistry.getArtifact(principal, params.botId, params.artifactId)
      if (!artifact) return reply.code(404).send({ error: "BOT_ARTIFACT_NOT_FOUND" })
      const body = request.body as Record<string, unknown>
      const targetTier = body.targetTier === "desktop" ? "desktop" : body.targetTier === "headless" ? "headless" : null
      if (!targetTier) return reply.code(400).send({ error: "ARTIFACT_TARGET_TIER_INVALID" })
      const targetEnvironmentId = typeof body.targetEnvironmentId === "string" ? body.targetEnvironmentId.trim() : undefined
      const { session, lease } = runtimeLeaseForPrincipal(runtimeBroker, principal, params.botId, targetTier, targetEnvironmentId)
      const targetProvider = leaseHandsProvider(lease.details.kind)
      if (artifact.storageProvider !== targetProvider) throw new Error("ARTIFACT_CROSS_PROVIDER_POLICY_REQUIRED")
      const targetPath = typeof body.targetPath === "string" ? body.targetPath : `${lease.details.cwd.replace(/\/$/, "")}/${artifact.path.split("/").at(-1) || "artifact"}`
      const relativePath = relativeArtifactPath(lease.details.cwd, targetPath)
      if (!lease.writeFile) throw new Error("RUNTIME_ARTIFACT_WRITE_UNSUPPORTED")
      const backend = handsBackendFor(artifact.storageProvider)
      const shouldOpen = body.open === true && targetTier === "desktop"
      const actor = { principal, botId: params.botId, accessToken, sessionId: session.id }
      if (shouldOpen) await assertCapability(context.capabilityGate, principal, PERSONAL_BOT_COMPUTER_USE, accessToken)
      const performImport = async () => {
        if (artifact.storageProvider === "cloudflare-hands" && (!artifact.sourceWorkspaceId || !artifact.storageRef)) throw new Error("ARTIFACT_STORAGE_REFERENCE_REQUIRED")
        const source = artifact.sourceWorkspaceId ? context.workspaces.get(principal, params.botId, artifact.sourceWorkspaceId) : null
        const bytes = await backend.readArtifact(source, artifact.artifactId, () => botRegistry.readArtifactBytes(artifact.artifactId), principal.acting_client_id)
        if (bytes.byteLength > 10 * 1024 * 1024 || bytes.byteLength !== artifact.size || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== artifact.digest) throw new Error("ARTIFACT_DIGEST_MISMATCH")
        await lease.writeFile!(relativePath, bytes)
        if (shouldOpen && lease.openFile) await lease.openFile(relativePath)
      }
      await context.handsPlacement.run(actor, targetProvider, () => context.handsPlacement.runCapability(actor, "filesystem.read", "invoke", () => context.handsPlacement.runCapability(actor, "filesystem.write", "invoke", () =>
        shouldOpen ? context.handsPlacement.runCapability(actor, "computer.use", "invoke", performImport) : performImport(),
      )))
      console.info(JSON.stringify({
        event: "bot.artifact.imported",
        artifact_id: artifact.artifactId,
        tenant_id: artifact.tenantId,
        bot_id: artifact.botId,
        runtime_tier: targetTier,
        environment_id: targetEnvironmentId ?? lease.details.environmentId,
        target_path: targetPath,
        opened: shouldOpen && Boolean(lease.openFile),
        correlation_id: artifact.artifactId,
      }))
      return reply.send({ artifact, targetTier, targetPath, imported: true, opened: shouldOpen && Boolean(lease.openFile) })
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "BOT_ARTIFACT_IMPORT_FAILED" })
    }
  })
}
