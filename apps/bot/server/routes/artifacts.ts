import { createHash } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { requestPrincipal } from "../auth"
import type { BotServerContext } from "../context"
import type { GenioPrincipal, RuntimeBroker } from "../runtime-broker"

function runtimeLeaseForPrincipal(runtimeBroker: RuntimeBroker, principal: GenioPrincipal, tier: "headless" | "desktop", environmentId?: string) {
  const session = runtimeBroker.findByPrincipal(principal)
  const lease = session?.leases[tier]
  if (!session || !lease) throw new Error("RUNTIME_LEASE_NOT_FOUND")
  if (environmentId && lease.details.environmentId !== environmentId) throw new Error("RUNTIME_ENVIRONMENT_NOT_OWNED")
  return { session, lease }
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
      const body = request.body as Record<string, unknown>
      const tier = body.sourceTier === "desktop" ? "desktop" : body.sourceTier === "headless" ? "headless" : null
      if (!tier) throw new Error("ARTIFACT_RUNTIME_TIER_INVALID")
      const sourceEnvironmentId = typeof body.sourceEnvironmentId === "string" ? body.sourceEnvironmentId.trim() : ""
      const path = typeof body.path === "string" ? body.path.trim() : ""
      if (!sourceEnvironmentId || !path) throw new Error("ARTIFACT_SOURCE_REQUIRED")
      if (!/^\/home\/user\/[A-Za-z0-9._/-]+$/.test(path) || path.split("/").includes("..")) throw new Error("ARTIFACT_PATH_INVALID")
      const { lease } = runtimeLeaseForPrincipal(runtimeBroker, principal, tier, sourceEnvironmentId)
      if (!lease.readFile) throw new Error("RUNTIME_ARTIFACT_READ_UNSUPPORTED")
      const bytes = await lease.readFile(path)
      if (bytes.byteLength > 10 * 1024 * 1024) throw new Error("ARTIFACT_TOO_LARGE")
      const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`
      const artifact = botRegistry.registerArtifact(principal, {
        botId: (request.params as { botId: string }).botId,
        sourceTier: tier,
        sourceEnvironmentId,
        path,
        digest,
        contentType: typeof body.contentType === "string" ? body.contentType : undefined,
        size: bytes.byteLength,
      })
      botRegistry.storeArtifactBytes(artifact.artifactId, bytes)
      console.info(JSON.stringify({
        event: "bot.artifact.captured",
        artifact_id: artifact.artifactId,
        tenant_id: artifact.tenantId,
        bot_id: artifact.botId,
        runtime_tier: artifact.sourceTier,
        environment_id: artifact.sourceEnvironmentId,
        digest: artifact.digest,
        size: artifact.size,
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
      const params = request.params as { botId: string; artifactId: string }
      const artifact = botRegistry.getArtifact(principal, params.botId, params.artifactId)
      if (!artifact) return reply.code(404).send({ error: "BOT_ARTIFACT_NOT_FOUND" })
      const body = request.body as Record<string, unknown>
      const targetTier = body.targetTier === "desktop" ? "desktop" : body.targetTier === "headless" ? "headless" : null
      if (!targetTier) return reply.code(400).send({ error: "ARTIFACT_TARGET_TIER_INVALID" })
      const targetEnvironmentId = typeof body.targetEnvironmentId === "string" ? body.targetEnvironmentId.trim() : undefined
      const targetPath = typeof body.targetPath === "string" ? body.targetPath.trim() : `/home/user/${artifact.path.split("/").at(-1) || "artifact"}`
      if (!/^\/home\/user\/[A-Za-z0-9._/-]+$/.test(targetPath) || targetPath.split("/").includes("..")) throw new Error("ARTIFACT_TARGET_PATH_INVALID")
      const { lease } = runtimeLeaseForPrincipal(runtimeBroker, principal, targetTier, targetEnvironmentId)
      if (!lease.writeFile) throw new Error("RUNTIME_ARTIFACT_WRITE_UNSUPPORTED")
      const bytes = botRegistry.readArtifactBytes(artifact.artifactId)
      await lease.writeFile(targetPath, bytes)
      const shouldOpen = body.open === true && targetTier === "desktop"
      if (shouldOpen && lease.openFile) await lease.openFile(targetPath)
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
