import type { FastifyInstance } from "fastify"
import { createHash } from "node:crypto"
import { ensureAgentSubject } from "../agent-subject"
import { requestAccessToken, requestPrincipal } from "../auth"
import type { BotServerContext } from "../context"
import {
  bindingStateForAdd,
  resolveCatalogAddState,
  type CatalogCapabilityView,
} from "../bot-binding-add"
import { RuntimePolicyUnavailableError } from "../runtime-policy"
import type { GenioPrincipal } from "../runtime-broker"
import { BotUsageContextError, resolveBotUsageContext } from "../usage-context"
import { PlatformDistillationCancellationError } from "../bot-deletion-reconciler"
import { normalizeTeamWorkspaceId } from "../bot-registry"
import { platformOrigin } from "../platform-origin"

type PlatformPersonalConnection = {
  connection_id: string
  display_name: string
  authentication: "OAUTH" | "PASSWORD"
  status: "CONNECTED" | "SAVED" | "NEEDS_CONNECTION"
}

class PlatformConnectionProxyError extends Error {
  constructor(readonly code: string, readonly statusCode: number) {
    super(code)
  }
}

class TeamWorkspaceValidationError extends Error {
  constructor(readonly code: string, readonly statusCode: number) {
    super(code)
  }
}

async function assertTeamWorkspaceContributor(accessToken: string, tenantId: string, workspaceId: string): Promise<void> {
  let response: Response
  try {
    const workspaceUrl = new URL(`/v1/tenants/${encodeURIComponent(tenantId)}/team-workspaces/${encodeURIComponent(workspaceId)}`, platformOrigin())
    workspaceUrl.searchParams.set("access", "contributor")
    response = await fetch(workspaceUrl, {
      headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(2_000),
    })
  } catch {
    throw new TeamWorkspaceValidationError("TEAM_WORKSPACE_UNAVAILABLE", 503)
  }
  if (response.ok) {
    const body = await response.json().catch(() => null) as { workspace_id?: unknown } | null
    if (body?.workspace_id === workspaceId) return
    throw new TeamWorkspaceValidationError("TEAM_WORKSPACE_UNAVAILABLE", 503)
  }
  if (response.status === 401) throw new TeamWorkspaceValidationError("TEAM_WORKSPACE_UNAUTHENTICATED", 401)
  if (response.status === 403) throw new TeamWorkspaceValidationError("TEAM_WORKSPACE_CONTRIBUTOR_REQUIRED", 403)
  if (response.status === 404) throw new TeamWorkspaceValidationError("TEAM_WORKSPACE_NOT_FOUND", 400)
  if (response.status >= 500) throw new TeamWorkspaceValidationError("TEAM_WORKSPACE_UNAVAILABLE", 503)
  throw new TeamWorkspaceValidationError("TEAM_WORKSPACE_INVALID", 400)
}

async function platformConnectionRequest<T>(accessToken: string, path: string, init: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    const headers = new Headers(init.headers)
    headers.set("accept", "application/json")
    headers.set("authorization", `Bearer ${accessToken}`)
    if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json")
    response = await fetch(new URL(path, platformOrigin()), { ...init, headers, signal: init.signal ?? AbortSignal.timeout(2_000) })
  } catch (error) {
    if (error instanceof PlatformConnectionProxyError) throw error
    throw new PlatformConnectionProxyError("CONNECTION_PLATFORM_UNAVAILABLE", 503)
  }
  const text = await response.text()
  if (!response.ok) {
    const status = response.status === 401 ? 401 : response.status === 403 ? 403 : response.status >= 400 && response.status < 500 ? 409 : 502
    throw new PlatformConnectionProxyError(`CONNECTION_PLATFORM_HTTP_${response.status}`, status)
  }
  try {
    return (text ? JSON.parse(text) : null) as T
  } catch {
    throw new PlatformConnectionProxyError("CONNECTION_PLATFORM_INVALID_RESPONSE", 502)
  }
}

function parsePlatformConnections(value: unknown): PlatformPersonalConnection[] {
  if (!Array.isArray(value)) throw new PlatformConnectionProxyError("CONNECTION_PLATFORM_INVALID_RESPONSE", 502)
  const connections = value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return []
    const row = candidate as Record<string, unknown>
    if (
      typeof row.connection_id !== "string" || !row.connection_id.trim() ||
      typeof row.display_name !== "string" ||
      !["OAUTH", "PASSWORD"].includes(String(row.authentication)) ||
      !["CONNECTED", "SAVED", "NEEDS_CONNECTION"].includes(String(row.status))
    ) return []
      return [{
      connection_id: row.connection_id,
      display_name: row.display_name,
      authentication: row.authentication as PlatformPersonalConnection["authentication"],
      status: row.status as PlatformPersonalConnection["status"],
      }]
  })
  if (connections.length !== value.length) throw new PlatformConnectionProxyError("CONNECTION_PLATFORM_INVALID_RESPONSE", 502)
  return connections
}

async function platformPersonalConnections(accessToken: string, principal: GenioPrincipal, resourceId: string) {
  const value = await platformConnectionRequest<unknown>(
    accessToken,
    `/v1/tenants/${encodeURIComponent(principal.tenant_id)}/me/resource-connections/${encodeURIComponent(resourceId)}`,
  )
  return parsePlatformConnections(value)
}

function safeAuthorizationUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw new PlatformConnectionProxyError("CONNECTION_PLATFORM_INVALID_RESPONSE", 502)
  let url: URL
  try { url = new URL(value) } catch { throw new PlatformConnectionProxyError("CONNECTION_PLATFORM_INVALID_RESPONSE", 502) }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) {
    throw new PlatformConnectionProxyError("CONNECTION_AUTHORIZATION_URL_INVALID", 502)
  }
  return url.toString()
}

async function startPlatformOAuth(accessToken: string, principal: GenioPrincipal, resourceId: string) {
  const connections = await platformPersonalConnections(accessToken, principal, resourceId)
  const oauth = connections.find((connection) => connection.authentication === "OAUTH")
  if (!oauth) throw new PlatformConnectionProxyError("CONNECTION_OAUTH_NOT_CONFIGURED", 409)
  if (oauth.status === "CONNECTED") {
    return {
      status: "CONNECTED" as const,
      provider: "platform" as const,
      connectionId: oauth.connection_id,
      alreadyConnected: true,
      addState: "CONNECTED" as const,
      scope: "account" as const,
      reusableAcrossBots: true as const,
    }
  }
  const authorization = await platformConnectionRequest<{ authorization_url?: unknown; expires_at?: unknown }>(
    accessToken,
    `/v1/tenants/${encodeURIComponent(principal.tenant_id)}/me/resource-connections/${encodeURIComponent(resourceId)}/${encodeURIComponent(oauth.connection_id)}/authorize`,
    { method: "POST" },
  )
  const expiresAt = typeof authorization.expires_at === "number" && Number.isFinite(authorization.expires_at)
    ? authorization.expires_at
    : null
  if (expiresAt === null) throw new PlatformConnectionProxyError("CONNECTION_PLATFORM_INVALID_RESPONSE", 502)
  return {
    status: "NEEDS_CONNECTION" as const,
    provider: "platform" as const,
    connectionId: oauth.connection_id,
    authorizationUrl: safeAuthorizationUrl(authorization.authorization_url),
    expiresAt,
    addState: "NEEDS_CONNECTION" as const,
    scope: "account" as const,
    reusableAcrossBots: true as const,
  }
}

async function platformOAuthStatus(accessToken: string, principal: GenioPrincipal, resourceId: string, requestedConnectionId: string) {
  const connections = await platformPersonalConnections(accessToken, principal, resourceId)
  const oauth = connections.find((connection) => connection.authentication === "OAUTH" && (!requestedConnectionId || connection.connection_id === requestedConnectionId))
  if (!oauth) throw new PlatformConnectionProxyError("CONNECTION_OAUTH_NOT_FOUND", 404)
  return {
    status: oauth.status === "CONNECTED" ? "CONNECTED" as const : "NEEDS_CONNECTION" as const,
    provider: "platform" as const,
    connectionId: oauth.connection_id,
    addState: oauth.status === "CONNECTED" ? "CONNECTED" as const : "NEEDS_CONNECTION" as const,
  }
}

function connectionProxyError(error: unknown, fallback: string) {
  if (error instanceof PlatformConnectionProxyError) return { status: error.statusCode, message: error.code }
  return { status: 400, message: error instanceof Error ? error.message : fallback }
}

export async function botRoutes(app: FastifyInstance, context: BotServerContext) {
  const { botRegistry } = context

  app.post("/api/bots/:botId/timeline/legacy-import", async (request, reply) => {
    const principal = await requestPrincipal(request)
    const bot = botRegistry.getOwned((request.params as { botId: string }).botId, principal)
    if (!bot) return reply.code(404).send({ error: "BOT_NOT_FOUND" })
    try {
      return reply.send(botRegistry.timeline.importLegacy(bot.id, request.body))
    } catch (error) {
      if (error instanceof Error && error.message === "LEGACY_HISTORY_INVALID") return reply.code(400).send({ error: error.message })
      throw error
    }
  })

  app.get("/api/bots/:botId/timeline", async (request, reply) => {
    try {
      const timeline = botRegistry.readTimeline(await requestPrincipal(request), (request.params as { botId: string }).botId, (id) => Boolean(context.runtimeBroker.get(id)))
      const body = JSON.stringify(timeline)
      const etag = `"${createHash("sha256").update(body).digest("hex")}"`
      reply.header("etag", etag).header("cache-control", "private, no-cache").header("vary", "authorization")
      if (request.headers["if-none-match"] === etag) return reply.code(304).send()
      return reply.type("application/json").send(body)
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : "BOT_TIMELINE_UNAVAILABLE" })
    }
  })

  app.get("/api/bots/:botId/execution-segments", async (request, reply) => {
    const principal = await requestPrincipal(request)
    const bot = botRegistry.getOwned((request.params as { botId: string }).botId, principal)
    if (!bot) return reply.code(404).send({ error: "BOT_NOT_FOUND" })
    return reply.send(botRegistry.getSessionThreads(bot.id))
  })

  app.get("/api/bots", async (request, reply) => {
    try {
      return reply.send(botRegistry.list(await requestPrincipal(request)))
    } catch (error) {
      return reply.code(401).send({ error: error instanceof Error ? error.message : "BOT_AUTH_REQUIRED" })
    }
  })

  app.get("/api/bots/roster", async (request, reply) => {
    try {
      const principal = await requestPrincipal(request)
      const runtime = context.runtimeBroker.findByPrincipal(principal)
      return reply.send(botRegistry.listRoster(principal).map(({ bot, session, summary }) => ({
        summary: { ...summary, waitingFor: runtime ? context.runtimeBroker.waitingFor(runtime.id, botRegistry.getSessionThreads(bot.id).map((thread) => thread.threadId)) : undefined },
        bot,
        session,
      })))
    } catch (error) {
      return reply.code(401).send({ error: error instanceof Error ? error.message : "BOT_AUTH_REQUIRED" })
    }
  })

  app.post("/api/bots", async (request, reply) => {
    try {
      const principal = await requestPrincipal(request)
      const accessToken = requestAccessToken(request)
      const body = request.body as Record<string, unknown>
      const displayName = typeof body.name === "string" ? body.name : "Genio Bot"
      const wake = body.wake === "chat" || body.wake === "routine" || body.wake === "both" ? body.wake : undefined
      const modelRoute = body.modelRoute === "genio-gateway" ? "genio-gateway" as const : "codex-subscription" as const
      let requestedUseCaseId: string | undefined
      if (body.useCaseId !== undefined) {
        if (typeof body.useCaseId !== "string" || !body.useCaseId.trim()) throw new BotUsageContextError("USE_CASE_INVALID", 400)
        requestedUseCaseId = body.useCaseId.trim()
      }
      const teamWorkspaceId = body.teamWorkspaceId === null ? null : typeof body.teamWorkspaceId === "string" ? body.teamWorkspaceId : undefined
      if (typeof teamWorkspaceId === "string") {
        normalizeTeamWorkspaceId(teamWorkspaceId)
        await assertTeamWorkspaceContributor(accessToken, principal.tenant_id, teamWorkspaceId)
      }
      const usageContext = await resolveBotUsageContext({ principal, accessToken, useCaseId: requestedUseCaseId })
      if (modelRoute === "genio-gateway" && !usageContext && Array.isArray(principal.organization_ids) && principal.organization_ids.length > 0) {
        throw new BotUsageContextError("USE_CASE_REQUIRED", 409)
      }
      const agent = await ensureAgentSubject({ principal, accessToken, displayName })
      const bot = botRegistry.create(principal, {
        name: displayName,
        title: typeof body.title === "string" ? body.title : undefined,
        description: typeof body.description === "string" ? body.description
          : typeof body.role === "string" ? body.role : undefined,
        antiJobs: typeof body.antiJobs === "string" ? body.antiJobs : undefined,
        voice: typeof body.voice === "string" ? body.voice : undefined,
        wake,
        avatar: body.avatar,
        // Designer create: empty skills unless caller opts in. Never default-install plugins.
        skills: Array.isArray(body.skills) ? body.skills.filter((value): value is string => typeof value === "string") : [],
        allowedTools: Array.isArray(body.allowedTools) ? body.allowedTools.filter((value): value is string => typeof value === "string") : undefined,
        modelRoute,
        defaultRuntimeTier: body.defaultRuntimeTier === "headless" || body.defaultRuntimeTier === "desktop" ? body.defaultRuntimeTier : "none",
        agentSubjectId: agent.subjectId,
        ownerOrganizationId: usageContext?.consumerOrganizationId ?? null,
        useCaseId: usageContext?.useCaseId ?? null,
        teamWorkspaceId,
      })
      return reply.code(201).send(bot)
    } catch (error) {
      const status = error instanceof BotUsageContextError || error instanceof TeamWorkspaceValidationError ? error.statusCode : 400
      return reply.code(status).send({ error: error instanceof Error ? error.message : "BOT_CREATE_FAILED" })
    }
  })


  app.get("/api/bots/:botId", async (request, reply) => {
    try {
      const principal = await requestPrincipal(request)
      const botId = (request.params as { botId: string }).botId
      const profile = botRegistry.getProfile(botId, principal)
      if (!profile) return reply.code(404).send({ error: "BOT_NOT_FOUND" })
      return reply.send(profile)
    } catch (error) {
      return reply.code(401).send({ error: error instanceof Error ? error.message : "BOT_AUTH_REQUIRED" })
    }
  })

  app.get("/api/bots/:botId/runtime-policy", async (request, reply) => {
    try {
      const principal = await requestPrincipal(request)
      const botId = (request.params as { botId: string }).botId
      const bot = botRegistry.getOwned(botId, principal)
      if (!bot) return reply.code(404).send({ error: "BOT_NOT_FOUND" })
      const snapshot = await context.runtimePolicy.read({
        principal,
        botId: bot.id,
        runtimeId: "codex",
        action: "expose",
        accessToken: requestAccessToken(request),
      })
      reply.header("cache-control", "private, no-store").header("vary", "authorization")
      return reply.send(snapshot)
    } catch (error) {
      const message = error instanceof RuntimePolicyUnavailableError
        ? error.code
        : error instanceof Error ? error.message : "RUNTIME_POLICY_UNAVAILABLE"
      const status = message === "BOT_NOT_FOUND" ? 404 : message === "GENIO_ONE_SESSION_TOKEN_REQUIRED" ? 401 : 503
      return reply.code(status).send({ error: status === 503 ? "RUNTIME_POLICY_UNAVAILABLE" : message })
    }
  })

  app.patch("/api/bots/:botId", async (request, reply) => {
    try {
      const principal = await requestPrincipal(request)
      const body = request.body as Record<string, unknown>
      const teamWorkspaceId = body.teamWorkspaceId === null ? null : typeof body.teamWorkspaceId === "string" ? body.teamWorkspaceId : undefined
      if (typeof teamWorkspaceId === "string") {
        normalizeTeamWorkspaceId(teamWorkspaceId)
        await assertTeamWorkspaceContributor(requestAccessToken(request), principal.tenant_id, teamWorkspaceId)
      }
      if (body.expectedRevision !== undefined && (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1)) throw new Error("BOT_PROFILE_REVISION_INVALID")
      const share = body.sharePolicy && typeof body.sharePolicy === "object" ? body.sharePolicy as Record<string, unknown> : undefined
      const wake = body.wake === "chat" || body.wake === "routine" || body.wake === "both" || body.wake === ""
        ? body.wake
        : undefined
      const bot = botRegistry.update((request.params as { botId: string }).botId, principal, {
        expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
        name: typeof body.name === "string" ? body.name : undefined,
        title: typeof body.title === "string" ? body.title : undefined,
        description: typeof body.description === "string" ? body.description
          : typeof body.role === "string" ? body.role : undefined,
        antiJobs: typeof body.antiJobs === "string" ? body.antiJobs : undefined,
        voice: typeof body.voice === "string" ? body.voice : undefined,
        wake,
        avatar: body.avatar,
        skills: Array.isArray(body.skills) ? body.skills.filter((value): value is string => typeof value === "string") : undefined,
        allowedTools: Array.isArray(body.allowedTools) ? body.allowedTools.filter((value): value is string => typeof value === "string") : undefined,
        modelRoute: body.modelRoute === "genio-gateway" ? "genio-gateway" : body.modelRoute === "codex-subscription" ? "codex-subscription" : undefined,
        defaultRuntimeTier: body.defaultRuntimeTier === "headless" || body.defaultRuntimeTier === "desktop" || body.defaultRuntimeTier === "none" ? body.defaultRuntimeTier : undefined,
        teamWorkspaceId,
        sharePolicy: share ? {
          visibility: share.visibility as never,
          discoverable: share.discoverable === true,
          invocable: share.invocable === true,
          approval: share.approval as never,
          audienceIds: Array.isArray(share.audienceIds) ? share.audienceIds.filter((value): value is string => typeof value === "string") : [],
        } : undefined,
      })
      return reply.send(bot)
    } catch (error) {
      const status = error instanceof TeamWorkspaceValidationError ? error.statusCode : 400
      return reply.code(status).send({ error: error instanceof Error ? error.message : "BOT_UPDATE_FAILED" })
    }
  })

  app.post("/api/bots/:botId/duplicate", async (request, reply) => {
    try {
      const principal = await requestPrincipal(request)
      const accessToken = requestAccessToken(request)
      const source = botRegistry.getOwned((request.params as { botId: string }).botId, principal)
      if (!source) return reply.code(404).send({ error: "BOT_NOT_FOUND" })
      if (source.teamWorkspaceId) {
        await assertTeamWorkspaceContributor(accessToken, principal.tenant_id, source.teamWorkspaceId)
      }
      const agent = await ensureAgentSubject({ principal, accessToken, displayName: `${source.name} 副本` })
      const bot = botRegistry.duplicate(source.id, principal, agent.subjectId)
      return reply.code(201).send(bot)
    } catch (error) {
      const status = error instanceof TeamWorkspaceValidationError ? error.statusCode : 400
      return reply.code(status).send({ error: error instanceof Error ? error.message : "BOT_DUPLICATE_FAILED" })
    }
  })

  app.delete("/api/bots/:botId", async (request, reply) => {
    let deletion: { created: boolean } | null = null
    let principal: GenioPrincipal | null = null
    let botId = ""
    try {
      principal = await requestPrincipal(request)
      botId = (request.params as { botId: string }).botId
      const accessToken = requestAccessToken(request)
      const deletionReconciler = context.botDeletionReconciler
      deletion = botRegistry.beginPendingDeletion(botId, principal)
      if (!deletion) return reply.code(404).send({ error: "BOT_NOT_FOUND" })
      await deletionReconciler.attempt(principal, botId, accessToken)
      return reply.code(200).send({ ok: true, botId })
    } catch (error) {
      if (error instanceof PlatformDistillationCancellationError) return reply.code(error.statusCode).send({ error: error.code })
      const message = error instanceof Error ? error.message : "BOT_DELETE_FAILED"
      return reply.code(message.startsWith("GENIO_ONE_SESSION_") ? 401 : message === "BOT_NOT_FOUND" ? 404 : 400).send({ error: message })
    }
  })


  app.get("/api/bots/:botId/bindings", async (request, reply) => {
    try {
      const principal = await requestPrincipal(request)
      const botId = (request.params as { botId: string }).botId
      return reply.send(botRegistry.listBindings(botId, principal))
    } catch (error) {
      const message = error instanceof Error ? error.message : "BOT_BINDINGS_READ_FAILED"
      return reply.code(message === "BOT_NOT_FOUND" ? 404 : 400).send({ error: message })
    }
  })

  app.delete("/api/bots/:botId/bindings/:resourceId", async (request, reply) => {
    try {
      const principal = await requestPrincipal(request)
      const { botId, resourceId } = request.params as { botId: string; resourceId: string }
      const removedCount = botRegistry.removeBindingsForResource(botId, principal, resourceId)
      return reply.send({ botId, resourceId, removedCount })
    } catch (error) {
      const message = error instanceof Error ? error.message : "BOT_BINDINGS_REMOVE_FAILED"
      return reply.code(message === "BOT_NOT_FOUND" ? 404 : 400).send({ error: message })
    }
  })

  app.get("/api/bots/:botId/catalog-add", async (request, reply) => {
    try {
      const principal = await requestPrincipal(request)
      const botId = (request.params as { botId: string }).botId
      const bot = botRegistry.getOwned(botId, principal)
      if (!bot) return reply.code(404).send({ error: "BOT_NOT_FOUND" })
      const accessToken = requestAccessToken(request)
      const capabilities = await fetchCatalogCapabilities(accessToken, principal.tenant_id, principal)
      const rows = capabilities.map((cap) => {
        const decision = resolveCatalogAddState(cap)
        const existing = bot.bindings.find(
          (b) => b.resourceId === String(cap.resource_id || "") && b.capabilityId === String(cap.capability_id || ""),
        )
        return {
          resourceId: String(cap.resource_id || ""),
          capabilityId: String(cap.capability_id || ""),
          builtinService: cap.builtin_service ?? null,
          resourceDisplayName: String((cap as { resource_display_name?: string }).resource_display_name || cap.resource_id || ""),
          capabilityDisplayName: String((cap as { capability_display_name?: string }).capability_display_name || cap.capability_id || ""),
          addState: decision.state,
          connectionStatus: decision.connectionStatus,
          reason: decision.reason,
          approvalPolicyRef: decision.approvalPolicyRef,
          skillId: decision.skillId,
          installBinding: decision.installBinding,
          pendingBinding: decision.pendingBinding,
          usableFromCatalogAlone: decision.usableFromCatalogAlone,
          binding: existing ?? null,
        }
      })
      return reply.send({ botId, bindings: bot.bindings, catalog: rows })
    } catch (error) {
      const message = error instanceof Error ? error.message : "BOT_CATALOG_ADD_FAILED"
      return reply.code(message === "BOT_NOT_FOUND" ? 404 : 400).send({ error: message })
    }
  })

  app.post("/api/bots/:botId/bindings/add", async (request, reply) => {
    try {
      const principal = await requestPrincipal(request)
      const botId = (request.params as { botId: string }).botId
      const bot = botRegistry.getOwned(botId, principal)
      if (!bot) return reply.code(404).send({ error: "BOT_NOT_FOUND" })
      const body = request.body as Record<string, unknown>
      const resourceId = typeof body.resourceId === "string" ? body.resourceId : ""
      const capabilityId = typeof body.capabilityId === "string" ? body.capabilityId : ""
      if (!resourceId || !capabilityId) return reply.code(400).send({ error: "BOT_BINDING_TARGET_REQUIRED" })

      const accessToken = requestAccessToken(request)
      const capabilities = await fetchCatalogCapabilities(accessToken, principal.tenant_id, principal)
      const cap = capabilities.find(
        (candidate) => candidate.resource_id === resourceId && candidate.capability_id === capabilityId,
      )
      // Missing from catalog → no entitlement → DENIED (never default-available)
      const view: CatalogCapabilityView = cap ?? {
        resource_id: resourceId,
        capability_id: capabilityId,
        access: "DENIED",
        denial_reason: "capability_not_in_catalog",
      }
      if (typeof body.approvalPolicyRef === "string") view.approval_policy_ref = body.approvalPolicyRef
      if (typeof body.skillId === "string") view.skill_id = body.skillId

      const decision = resolveCatalogAddState(view)
      const nextState = bindingStateForAdd(decision)

      if (decision.state === "NEEDS_CONNECTION") {
        return reply.code(409).send({
          error: "BOT_CONNECTION_REQUIRED",
          addState: decision.state,
          reason: decision.reason,
          decision,
        })
      }
      if (decision.state === "DENIED" || !nextState) {
        if (nextState === "DENIED") {
          const denied = botRegistry.upsertBinding(botId, principal, {
            resourceId,
            capabilityId,
            state: "DENIED",
            kind: "MCP",
            skillId: decision.skillId,
            approvalPolicyRef: decision.approvalPolicyRef,
            reason: decision.reason,
          })
          return reply.code(403).send({
            error: "BOT_ACCESS_DENIED",
            addState: decision.state,
            reason: decision.reason,
            binding: denied,
            decision,
          })
        }
        return reply.code(403).send({
          error: "BOT_ACCESS_DENIED",
          addState: decision.state,
          reason: decision.reason,
          decision,
        })
      }

      const binding = botRegistry.upsertBinding(botId, principal, {
        resourceId,
        capabilityId,
        state: nextState,
        kind: typeof body.kind === "string" && ["SKILL", "PLUGIN", "MCP", "CONNECTION"].includes(body.kind)
          ? body.kind as "SKILL" | "PLUGIN" | "MCP" | "CONNECTION"
          : "MCP",
        skillId: decision.skillId,
        approvalPolicyRef: decision.approvalPolicyRef,
        reason: decision.reason,
        version: typeof body.version === "string" ? body.version : "1.0.0",
      })

      return reply.code(decision.state === "REQUEST" ? 202 : 201).send({
        addState: decision.state,
        reason: decision.reason,
        binding,
        decision,
        note: "BotBinding is a projection; calls still go through Gateway / One Policy",
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : "BOT_BINDING_ADD_FAILED"
      return reply.code(message === "BOT_NOT_FOUND" ? 404 : 400).send({ error: message })
    }
  })


  app.get("/api/connections", async (request, reply) => {
    try {
      const principal = await requestPrincipal(request)
      const resourceId = (request.query as { resourceId?: string }).resourceId
      if (!resourceId?.trim()) return reply.code(400).send({ error: "CONNECTION_RESOURCE_REQUIRED" })
      const connections = await platformPersonalConnections(requestAccessToken(request), principal, resourceId)
      const oauth = connections.find((connection) => connection.authentication === "OAUTH")
      return reply.send({ resourceId, status: oauth?.status === "CONNECTED" ? "CONNECTED" : "NEEDS_CONNECTION", connection: oauth ? { connectionId: oauth.connection_id, status: oauth.status, provider: "platform", reusableAcrossBots: true } : null, reusableAcrossBots: true, scope: "account" })
    } catch (error) {
      const result = connectionProxyError(error, "BOT_AUTH_REQUIRED")
      return reply.code(result.status === 400 ? 401 : result.status).send({ error: result.message })
    }
  })

  app.post("/api/connections/:resourceId/oauth/start", async (request, reply) => {
    try {
      const principal = await requestPrincipal(request)
      const started = await startPlatformOAuth(requestAccessToken(request), principal, (request.params as { resourceId: string }).resourceId)
      return reply.code(started.alreadyConnected ? 200 : 201).send(started)
    } catch (error) {
      const result = connectionProxyError(error, "CONNECTION_OAUTH_START_FAILED")
      return reply.code(result.status).send({ error: result.message })
    }
  })

  app.get("/api/connections/:resourceId/oauth/status", async (request, reply) => {
    try {
      const principal = await requestPrincipal(request)
      const resourceId = (request.params as { resourceId: string }).resourceId
      const connectionId = (request.query as { connectionId?: string }).connectionId ?? ""
      return reply.send(await platformOAuthStatus(requestAccessToken(request), principal, resourceId, connectionId))
    } catch (error) {
      const result = connectionProxyError(error, "CONNECTION_OAUTH_STATUS_FAILED")
      return reply.code(result.status).send({ error: result.message })
    }
  })

  app.get("/api/bots/:botId/session", async (request, reply) => {
    try {
      const principal = await requestPrincipal(request)
      const bot = botRegistry.getOwned((request.params as { botId: string }).botId, principal)
      if (!bot) return reply.code(404).send({ error: "BOT_NOT_FOUND" })
      return reply.send(botRegistry.getSession(bot.id))
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "BOT_SESSION_READ_FAILED" })
    }
  })

  app.get("/api/bots/:botId/sessions", async (request, reply) => {
    try {
      const principal = await requestPrincipal(request)
      const bot = botRegistry.getOwned((request.params as { botId: string }).botId, principal)
      if (!bot) return reply.code(404).send({ error: "BOT_NOT_FOUND" })
      const session = botRegistry.getSession(bot.id)
      return reply.send(session ? [session] : [])
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "BOT_SESSION_LIST_FAILED" })
    }
  })

  app.put("/api/bots/:botId/session", async (request, reply) => {
    try {
      const principal = await requestPrincipal(request)
      const bot = botRegistry.getOwned((request.params as { botId: string }).botId, principal)
      if (!bot) return reply.code(404).send({ error: "BOT_NOT_FOUND" })
      const body = request.body as Record<string, unknown>
      const tier = body.activeRuntimeTier === "headless" || body.activeRuntimeTier === "desktop" || body.activeRuntimeTier === "none"
        ? body.activeRuntimeTier
        : undefined
      if (typeof body.appServerThreadId === "string" && !botRegistry.ownsThread(principal, bot.id, body.appServerThreadId)) {
        return reply.code(400).send({ error: "BOT_THREAD_NOT_OWNED" })
      }
      if (body.workState !== undefined || body.unread !== undefined) return reply.code(400).send({ error: "BOT_WORK_STATE_SERVER_OWNED" })
      const session = botRegistry.saveSession({
        botId: bot.id,
        appServerThreadId: typeof body.appServerThreadId === "string" ? body.appServerThreadId
          : body.appServerThreadId === null ? null : undefined,
        activeRuntimeTier: tier,
        memoryPointer: typeof body.memoryPointer === "string" ? body.memoryPointer
          : body.memoryPointer === null ? null : undefined,
      })
      return reply.send(session)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "BOT_SESSION_SAVE_FAILED" })
    }
  })

  app.post("/api/bots/:botId/session/events", async (request, reply) => {
    try {
      const principal = await requestPrincipal(request)
      const bot = botRegistry.getOwned((request.params as { botId: string }).botId, principal)
      if (!bot) return reply.code(404).send({ error: "BOT_NOT_FOUND" })
      const body = request.body as Record<string, unknown>
      const type = body.type
      if (type !== "viewed") {
        return reply.code(400).send({ error: "BOT_WORK_STATE_SERVER_OWNED" })
      }
      const session = botRegistry.db.transaction(() => {
        const timeline = botRegistry.readTimeline(principal, bot.id, (id) => Boolean(context.runtimeBroker.get(id)))
        const version = `"${createHash("sha256").update(JSON.stringify(timeline)).digest("hex")}"`
        return body.version === version ? botRegistry.applySessionEvent(bot.id, type) : null
      })()
      if (!session) return reply.code(409).send({ error: "BOT_TIMELINE_CHANGED" })
      return reply.send(session)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "BOT_SESSION_EVENT_FAILED" })
    }
  })
}

async function fetchCatalogCapabilities(
  accessToken: string,
  tenantId: string,
  principal?: GenioPrincipalLike,
): Promise<CatalogCapabilityView[]> {
  const origin = process.env.GENIO_ONE_PLATFORM_ORIGIN?.trim() || "http://127.0.0.1:58082"
  try {
    const response = await fetch(new URL(`/v1/tenants/${encodeURIComponent(tenantId)}/catalog`, origin), {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(2_000),
    })
    if (!response.ok) throw new Error("BOT_CATALOG_UNAVAILABLE")
    const catalog = await response.json() as { capabilities?: CatalogCapabilityView[] }
    if (!Array.isArray(catalog.capabilities)) throw new Error("BOT_CATALOG_INVALID_RESPONSE")
    const caps = catalog.capabilities
    if (caps.length === 0) return []
    if (!principal) return caps

    const resourceIds = [...new Set(caps.flatMap((cap) => {
      const resourceId = typeof cap.resource_id === "string" ? cap.resource_id.trim() : ""
      const access = typeof cap.access === "string" ? cap.access : ""
      return resourceId && (access === "ENTITLED" || access === "AUTO_GRANT") ? [resourceId] : []
    }))]
    const connectionStates = new Map<string, PlatformPersonalConnection[] | null>()
    await Promise.all(resourceIds.map(async (resourceId) => {
      try {
        connectionStates.set(resourceId, await platformPersonalConnections(accessToken, principal, resourceId))
      } catch {
        connectionStates.set(resourceId, null)
      }
    }))
    return caps.map((cap) => {
      const resourceId = typeof cap.resource_id === "string" ? cap.resource_id.trim() : ""
      const connections = resourceId ? connectionStates.get(resourceId) : undefined
      if (connections === undefined || connections === null || connections.length === 0) return connections === null
        ? { ...cap, connection_status: "UNAVAILABLE", hub_status: "AVAILABLE" }
        : cap
      const connected = connections.some((connection) => connection.status === "CONNECTED")
      if (connected) return { ...cap, connection_status: "READY", hub_status: "CONNECTED" }
      const passwordSaved = connections.some((connection) => connection.authentication === "PASSWORD" && connection.status === "SAVED")
      if (passwordSaved) return { ...cap, connection_status: "SAVED", hub_status: "AVAILABLE" }
      return { ...cap, connection_status: "UNAVAILABLE", hub_status: "AVAILABLE" }
    })
  } catch {
    throw new Error("BOT_CATALOG_UNAVAILABLE")
  }
}

type GenioPrincipalLike = {
  tenant_id: string
  subject_id: string
  acting_client_id: string
  scopes: string[]
}
