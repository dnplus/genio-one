import type { GenioPrincipal } from "./runtime-broker"

export type BotModelRoute =
  | { kind: "codex-subscription" }
  | { kind: "genio-gateway"; modelProvider: string }

export interface BotModelPlan {
  publicModelId: string
  displayName: string
  route: BotModelRoute
}

export interface BotModelDirectory {
  availableRoutes(): readonly BotModelRoute["kind"][]
  supports(route: BotModelRoute): boolean
  resolve(principal: GenioPrincipal, botId?: string, route?: BotModelRoute, accessToken?: string): Promise<BotModelPlan[]>
}

interface GatewayPlanDefinition {
  plan: BotModelPlan
  resourceId?: string
  capabilityId?: string
}

interface PlatformCatalogCapability {
  resourceId: string
  capabilityId: string
  resourceKind?: string
  access: string
  connectionStatus: string
  hubStatus: string
}

interface PlatformCatalogResponse {
  capabilities: PlatformCatalogCapability[]
}

interface PlatformPublicModel {
  modelName: string
  resourceId: string
  lifecycle: string
}

export interface BotModelDirectoryOptions {
  fetcher?: BotModelFetcher
  platformOrigin?: string
}

export type BotModelFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function readGatewayPlans(environment: NodeJS.ProcessEnv): GatewayPlanDefinition[] {
  const raw = environment.GENIO_BOT_GENIO_GATEWAY_MODELS_JSON?.trim()
  if (!raw) throw new Error("GENIO_BOT_GENIO_GATEWAY_MODELS_REQUIRED")
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("GENIO_BOT_GENIO_GATEWAY_MODELS_INVALID")
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("GENIO_BOT_GENIO_GATEWAY_MODELS_INVALID")
  const plans = parsed.flatMap((value) => {
    if (!value || typeof value !== "object") return []
    const record = value as Record<string, unknown>
    const publicModelId = stringValue(record.publicModelId) ?? ""
    const displayName = stringValue(record.displayName) ?? publicModelId
    if (!publicModelId || !displayName) return []
    const resourceId = record.resourceId === undefined ? stringValue(record.resource_id) : stringValue(record.resourceId)
    const capabilityId = record.capabilityId === undefined ? stringValue(record.capability_id) : stringValue(record.capabilityId)
    if ((record.resourceId !== undefined || record.resource_id !== undefined) && !resourceId) return []
    if ((record.capabilityId !== undefined || record.capability_id !== undefined) && !capabilityId) return []
    return [{
      plan: {
        publicModelId,
        displayName,
        route: { kind: "genio-gateway" as const, modelProvider: "genio_one" },
      },
      ...(resourceId ? { resourceId } : {}),
      ...(capabilityId ? { capabilityId } : {}),
    }]
  })
  if (plans.length !== parsed.length) throw new Error("GENIO_BOT_GENIO_GATEWAY_MODELS_INVALID")
  return plans
}

function parsePlatformCatalog(value: unknown): PlatformCatalogResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("BOT_MODEL_CATALOG_UNAVAILABLE")
  const capabilities = (value as { capabilities?: unknown }).capabilities
  if (!Array.isArray(capabilities)) throw new Error("BOT_MODEL_CATALOG_UNAVAILABLE")
  return {
    capabilities: capabilities.flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return []
      const record = candidate as Record<string, unknown>
      const resourceId = stringValue(record.resource_id)
      const capabilityId = stringValue(record.capability_id)
      const access = stringValue(record.access)
      const connectionStatus = stringValue(record.connection_status)
      const hubStatus = stringValue(record.hub_status)
      if (!resourceId || !capabilityId || !access || !connectionStatus || !hubStatus) return []
      return [{
        resourceId,
        capabilityId,
        ...(stringValue(record.resource_kind) ? { resourceKind: stringValue(record.resource_kind) } : {}),
        access,
        connectionStatus,
        hubStatus,
      }]
    }),
  }
}

function parsePublicModels(value: unknown): PlatformPublicModel[] {
  if (!Array.isArray(value)) throw new Error("BOT_MODEL_CATALOG_UNAVAILABLE")
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return []
    const record = candidate as Record<string, unknown>
    const modelName = stringValue(record.model_name)
    const resourceId = stringValue(record.resource_id)
    const lifecycle = stringValue(record.lifecycle)
    if (!modelName || !resourceId || !lifecycle) return []
    return [{ modelName, resourceId, lifecycle }]
  })
}

function eligibleModelCapability(capability: PlatformCatalogCapability): boolean {
  if (capability.resourceKind && capability.resourceKind !== "LLM") return false
  if (capability.resourceKind !== "LLM" && capability.capabilityId !== "model.invoke") return false
  return (capability.access === "ENTITLED" || capability.access === "AUTO_GRANT") &&
    capability.connectionStatus === "READY" &&
    (capability.hubStatus === "CONNECTED" || capability.hubStatus === "AVAILABLE")
}

function matchesGatewayPlan(plan: GatewayPlanDefinition, model: PlatformPublicModel, capability: PlatformCatalogCapability): boolean {
  if (plan.resourceId && plan.resourceId !== capability.resourceId) return false
  if (plan.capabilityId && plan.capabilityId !== capability.capabilityId) return false
  return model.modelName === plan.plan.publicModelId && model.resourceId === capability.resourceId && capability.capabilityId === (plan.capabilityId ?? "model.invoke")
}

async function resolveGatewayPlans(
  principal: GenioPrincipal,
  plans: GatewayPlanDefinition[],
  accessToken: string | undefined,
  fetcher: BotModelFetcher,
  platformOrigin: string,
): Promise<BotModelPlan[]> {
  if (!accessToken?.trim()) throw new Error("BOT_MODEL_ENTITLEMENT_REQUIRED")
  let catalogResponse: Response
  let modelsResponse: Response
  try {
    const catalogUrl = new URL(`/v1/tenants/${encodeURIComponent(principal.tenant_id)}/catalog`, platformOrigin)
    const modelsUrl = new URL(`/v1/tenants/${encodeURIComponent(principal.tenant_id)}/me/models`, platformOrigin)
    ;[catalogResponse, modelsResponse] = await Promise.all([
      fetcher(catalogUrl, {
        headers: { authorization: `Bearer ${accessToken.trim()}`, accept: "application/json" },
        signal: AbortSignal.timeout(2_000),
      }),
      fetcher(modelsUrl, {
        headers: { authorization: `Bearer ${accessToken.trim()}`, accept: "application/json" },
        signal: AbortSignal.timeout(2_000),
      }),
    ])
  } catch {
    throw new Error("BOT_MODEL_CATALOG_UNAVAILABLE")
  }
  if (!catalogResponse.ok || !modelsResponse.ok) throw new Error("BOT_MODEL_CATALOG_UNAVAILABLE")
  let catalog: PlatformCatalogResponse
  let models: PlatformPublicModel[]
  try {
    ;[catalog, models] = await Promise.all([
      catalogResponse.json().then(parsePlatformCatalog),
      modelsResponse.json().then(parsePublicModels),
    ])
  } catch (error) {
    if (error instanceof Error && error.message === "BOT_MODEL_CATALOG_UNAVAILABLE") throw error
    throw new Error("BOT_MODEL_CATALOG_UNAVAILABLE")
  }
  const available = catalog.capabilities.filter(eligibleModelCapability)
  const publishedModels = models.filter((model) => model.lifecycle === "PUBLISHED")
  const resolved = plans.filter((plan) => publishedModels.some((model) => available.some((capability) => matchesGatewayPlan(plan, model, capability))))
  if (resolved.length === 0) throw new Error("BOT_MODEL_NOT_ENTITLED")
  return resolved.map(({ plan }) => plan)
}

export function createBotModelDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  options: BotModelDirectoryOptions = {},
): BotModelDirectory {
  const gatewayConfigured = Boolean(environment.GENIO_ONE_MODEL_GATEWAY_BASE_URL?.trim())
  const gatewayPlans = gatewayConfigured ? readGatewayPlans(environment) : null
  const fetcher = options.fetcher ?? globalThis.fetch
  const platformOrigin = options.platformOrigin?.trim() || environment.GENIO_ONE_PLATFORM_ORIGIN?.trim() || "http://127.0.0.1:58082"
  return {
    availableRoutes() {
      return gatewayPlans ? ["codex-subscription", "genio-gateway"] : ["codex-subscription"]
    },
    supports(route) {
      return route.kind === "codex-subscription" || (route.kind === "genio-gateway" && gatewayPlans !== null)
    },
    async resolve(principal, _botId, route = { kind: "codex-subscription" }, accessToken) {
      if (route.kind === "genio-gateway") {
        if (!gatewayPlans) throw new Error("GENIO_ONE_MODEL_GATEWAY_NOT_CONFIGURED")
        return resolveGatewayPlans(principal, gatewayPlans, accessToken, fetcher, platformOrigin)
      }
      return [{
        publicModelId: "*",
        displayName: "Codex subscription catalog",
        route,
      }]
    },
  }
}

export function selectPublicModel(plans: BotModelPlan[], requested?: string | null) {
  if (plans.some((plan) => plan.publicModelId === "*")) return requested?.trim() || plans[0]?.publicModelId || ""
  if (requested && plans.some((plan) => plan.publicModelId === requested)) return requested
  return plans[0]?.publicModelId || ""
}
