import type { FastifyInstance } from "fastify"
import { ensureAgentSubject } from "../agent-subject"
import { requestAccessToken, verifyGenioOneAccessToken } from "../auth"
import type { BotServerContext } from "../context"
import type { GenioPrincipal } from "../runtime-broker"
import { BotUsageContextError, resolveBotUsageContext } from "../usage-context"

export async function packageCatalogForRequest(context: BotServerContext, accessToken: string, principal: GenioPrincipal) {
  const { botRegistry } = context
  const packages = botRegistry.listPackages()
  const origin = process.env.GENIO_ONE_PLATFORM_ORIGIN?.trim() || "http://127.0.0.1:58082"
  const response = await fetch(new URL(`/v1/tenants/${encodeURIComponent(principal.tenant_id)}/catalog`, origin), {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    signal: AbortSignal.timeout(2_000),
  })
  if (!response.ok) {
    throw new Error("BOT_CATALOG_UNAVAILABLE")
  }
  const catalog = await response.json() as { capabilities?: Array<{ capability_id?: string; resource_id?: string; access?: string; hub_status?: string; connection_status?: string; resource_kind?: string; extension_metadata?: unknown }> }
  if (!Array.isArray(catalog.capabilities)) throw new Error("BOT_CATALOG_INVALID_RESPONSE")
  const capabilities = catalog.capabilities
  const extensionPackages = capabilities.flatMap((candidate) => {
    if (candidate.resource_kind !== "EXTENSION" || !candidate.extension_metadata || typeof candidate.extension_metadata !== "object") return []
    const metadata = candidate.extension_metadata as Record<string, unknown>
    if (metadata.package_type !== "BOT") return []
    const profile = metadata.profile && typeof metadata.profile === "object" ? metadata.profile as Record<string, unknown> : {}
    const skills = Array.isArray(metadata.skills) ? metadata.skills : []
    const plugins = Array.isArray(metadata.plugins) ? metadata.plugins : []
    const bindings = Array.isArray(metadata.resource_bindings) ? metadata.resource_bindings : []
    const manifest = {
      packageType: "BOT" as const,
      resourceId: candidate.resource_id || String(metadata.resource_id || ""),
      version: String(metadata.version || "1.0.0"),
      profile: {
        title: typeof profile.title === "string" ? profile.title : candidate.resource_id || "企業 Bot",
        description: typeof profile.description === "string" ? profile.description : "企業 Bot 套件",
        avatar: profile.avatar ?? { shape: "cercle", color: "turquoise", expression: "neutre" },
      },
      skills: skills.flatMap((value) => {
        if (!value || typeof value !== "object") return []
        const item = value as Record<string, unknown>
        return typeof item.id === "string" && typeof item.path === "string" ? [{ id: item.id, path: item.path, ...(typeof item.digest === "string" ? { digest: item.digest } : {}) }] : []
      }),
      plugins: plugins.flatMap((value) => {
        if (!value || typeof value !== "object") return []
        const item = value as Record<string, unknown>
        return typeof item.name === "string" ? [{
          name: item.name,
          ...(typeof item.marketplace === "string" ? { marketplace: item.marketplace } : {}),
          ...(typeof (item.marketplace_path ?? item.marketplacePath) === "string" ? { marketplacePath: String(item.marketplace_path ?? item.marketplacePath) } : {}),
          ...(typeof item.digest === "string" ? { digest: item.digest } : {}),
        }] : []
      }),
      resourceBindings: bindings.flatMap((value) => {
        if (!value || typeof value !== "object") return []
        const item = value as Record<string, unknown>
        return typeof item.resource_id === "string" && typeof item.capability_id === "string" ? [{ resourceId: item.resource_id, capabilityId: item.capability_id }] : []
      }),
      defaultRuntimeTier: (metadata.default_runtime_tier === "headless" || metadata.default_runtime_tier === "desktop" ? metadata.default_runtime_tier : "none") as "none" | "headless" | "desktop",
      modelRoute: metadata.model_route === "genio-gateway" || metadata.modelRoute === "genio-gateway" ? "genio-gateway" as const : "codex-subscription" as const,
      manifestDigest: String(metadata.manifest_digest || ""),
      artifactDigest: String(metadata.artifact_digest || ""),
      source: metadata.source && typeof metadata.source === "object" ? {
        kind: (metadata.source as Record<string, unknown>).kind === "GITHUB" || (metadata.source as Record<string, unknown>).kind === "UPLOAD" ? (metadata.source as Record<string, unknown>).kind as "GITHUB" | "UPLOAD" : "FIXTURE" as const,
        ref: String((metadata.source as Record<string, unknown>).ref || candidate.resource_id || "catalog"),
        ...((metadata.source as Record<string, unknown>).path ? { path: String((metadata.source as Record<string, unknown>).path) } : {}),
      } : undefined,
    }
    return [manifest]
  })
  const validExtensionPackages = [] as typeof extensionPackages
  for (const manifest of extensionPackages) {
    try {
      botRegistry.registerPackage(manifest)
      validExtensionPackages.push(manifest)
    } catch (error) {
      console.warn(JSON.stringify({ event: "bot.package.invalid", resource_id: manifest.resourceId, version: manifest.version, reason: error instanceof Error ? error.message : "BOT_PACKAGE_MANIFEST_INVALID" }))
    }
  }
  const mergedPackages = [...packages, ...validExtensionPackages.filter((candidate) => !packages.some((existing) => existing.resourceId === candidate.resourceId && existing.version === candidate.version))]
  return mergedPackages.map((manifest) => {
    const matches = manifest.resourceBindings.map((binding) => capabilities.find((candidate) =>
      candidate.capability_id === binding.capabilityId && candidate.resource_id === binding.resourceId))
      .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
    const packageCapability = capabilities.find((candidate) => candidate.resource_id === manifest.resourceId && candidate.resource_kind === "EXTENSION")
    const complete = Boolean(packageCapability) && matches.length === manifest.resourceBindings.length
    if (packageCapability) matches.push(packageCapability)
    const accessStatus = !complete || matches.some((candidate) => candidate.access !== "ENTITLED" && candidate.access !== "AUTO_GRANT" && candidate.access !== "REQUEST")
      ? "DENIED" as const
      : matches.some((candidate) => candidate.access === "REQUEST") ? "REQUEST" as const
        : matches.every((candidate) => candidate.access === "ENTITLED") ? "ENTITLED" as const : "AUTO_GRANT" as const
    const connectionStatus = complete && matches.every((candidate) => candidate.connection_status === "READY")
      ? "CONNECTED" as const : "NEEDS_CONNECTION" as const
    return { ...manifest, accessStatus, connectionStatus }
  })
}

export async function catalogRoutes(app: FastifyInstance, context: BotServerContext) {
  const { botRegistry } = context

  app.get("/api/bot-catalog", async (request, reply) => {
    try {
      const accessToken = requestAccessToken(request)
      const principal = await verifyGenioOneAccessToken(accessToken)
      return reply.send(await packageCatalogForRequest(context, accessToken, principal))
    } catch (error) {
      const message = error instanceof Error ? error.message : "BOT_AUTH_REQUIRED"
      return reply.code(message === "BOT_CATALOG_UNAVAILABLE" ? 503 : 401).send({ error: message })
    }
  })

  app.post("/api/bots/install", async (request, reply) => {
    try {
      const body = request.body as Record<string, unknown>
      const resourceId = typeof body.resourceId === "string" ? body.resourceId : ""
      const version = typeof body.version === "string" ? body.version : undefined
      const useCaseId = typeof body.useCaseId === "string" && body.useCaseId.trim() ? body.useCaseId.trim() : undefined
      const accessToken = requestAccessToken(request)
      const principal = await verifyGenioOneAccessToken(accessToken)
      const catalog = await packageCatalogForRequest(context, accessToken, principal)
      const manifest = catalog.find((candidate) => candidate.resourceId === resourceId && (!version || candidate.version === version))
      if (!manifest) throw new Error("BOT_PACKAGE_NOT_FOUND")
      if (manifest.accessStatus !== "ENTITLED" && manifest.accessStatus !== "AUTO_GRANT" && manifest.accessStatus !== "REQUEST") throw new Error("BOT_ACCESS_DENIED")
      if (manifest.accessStatus === "REQUEST") throw new Error("BOT_ACCESS_REQUEST_REQUIRED")
      if (manifest.connectionStatus !== "CONNECTED") throw new Error("BOT_CONNECTION_REQUIRED")
      const existing = botRegistry.findInstalled(principal, manifest.resourceId, manifest.version)
      if (existing) return reply.send(existing)
      const usageContext = manifest.modelRoute === "genio-gateway"
        ? await resolveBotUsageContext({ principal, accessToken, useCaseId })
        : null
      if (manifest.modelRoute === "genio-gateway" && !usageContext && Array.isArray(principal.organization_ids) && principal.organization_ids.length > 0) {
        throw new BotUsageContextError("USE_CASE_REQUIRED", 409)
      }
      const agent = await ensureAgentSubject({ principal, accessToken, displayName: manifest?.profile.title || "企業 Bot" })
      const bot = botRegistry.install(principal, resourceId, version, agent.subjectId, usageContext && {
        ownerOrganizationId: usageContext.consumerOrganizationId,
        useCaseId: usageContext.useCaseId,
      })
      return reply.code(201).send(bot)
    } catch (error) {
      return reply.code(error instanceof BotUsageContextError ? error.statusCode : 400).send({ error: error instanceof Error ? error.message : "BOT_INSTALL_FAILED" })
    }
  })
}
