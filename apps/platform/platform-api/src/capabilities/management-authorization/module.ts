import type { EndpointCredentialIdentity, EndpointRuntimeStore } from "../endpoint-runtime/module"
import type { FastifyRequest } from "fastify"

import { PlatformApiError } from "../errors"
import type { ResourceCatalog } from "../resources/module"
import type { RuntimeControlStore } from "../runtime-control/contract"
import type {
  EntitlementResolver,
  Principal,
  PrincipalAuthenticator,
} from "../tenancy-auth/contract"
import { normalizePrincipal } from "../tenancy-auth/memory"

const MANAGEMENT_SCOPE = "genioone-management"
const INVOCATION_SCOPE = "genioone-invocation"
const GATEWAY_RUNTIME_SCOPE = "genioone-gateway-runtime"
const ENDPOINT_RUNTIME_SCOPE = "genioone-endpoint-runtime"

interface TenantRoute {
  tenantId: string
  rest: string[]
}

export interface ManagementAuthorizationOptions {
  principalAuthenticator: PrincipalAuthenticator
  entitlementResolver?: EntitlementResolver
  resourceCatalog: ResourceCatalog
  endpointRuntime: EndpointRuntimeStore
  runtimeControl: RuntimeControlStore
}

export interface ManagementAuthorizationModule {
  authenticate(request: FastifyRequest): Promise<void>
  normalize(request: FastifyRequest): Promise<void>
  authorize(request: FastifyRequest): Promise<void>
  authorizeGatewayRuntime(input: {
    tenantId: string
    runtimeId: string
    request: { principal?: Principal }
  }): Promise<void>
  authorizeEndpoint(input: {
    tenantId: string
    deviceId: string
    request: { principal?: Principal }
  }): Promise<{ subjectId: string; credentialId: string }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function extractBearerToken(value: string | undefined): string | null {
  if (!value) return null
  const match = /^Bearer\s+(\S+)$/i.exec(value.trim())
  return match?.[1] ?? null
}

function tenantRoute(request: { url: string }): TenantRoute | null {
  const rawPath = request.url.split("?", 1)[0]
  if (rawPath.includes("\\") || rawPath.includes("\0")) return null
  const rawSegments = rawPath.split("/").filter(Boolean)
  if (rawSegments[0] !== "v1" || rawSegments[1] !== "tenants" || !rawSegments[2]) return null
  try {
    const decodedSegments = rawSegments.map((segment) => decodeURIComponent(segment))
    for (const segment of decodedSegments) {
      if (
        segment === ".." ||
        segment === "." ||
        segment.includes("/") ||
        segment.includes("\\") ||
        segment.includes("\0")
      ) {
        return null
      }
    }
    const tenantId = decodedSegments[2]
    if (!tenantId) return null
    return {
      tenantId,
      rest: decodedSegments.slice(3),
    }
  } catch {
    return null
  }
}

function isTenantAdministrator(principal: Principal): boolean {
  return principal.role === "TENANT_ADMINISTRATOR"
}

function assertTenantAdministrator(principal: Principal): void {
  if (!isTenantAdministrator(principal)) {
    throw new PlatformApiError(
      "TENANT_ADMINISTRATOR_REQUIRED",
      403,
      "This operation requires a Tenant Administrator",
    )
  }
}

function assertOrganizationManager(principal: Principal, organizationId: string | null): void {
  if (
    isTenantAdministrator(principal) ||
    (principal.role === "ORGANIZATION_ADMINISTRATOR" &&
      organizationId !== null &&
      principal.organization_ids.includes(organizationId))
  ) {
    return
  }
  throw new PlatformApiError(
    "RESOURCE_OWNER_OR_TENANT_ADMIN_REQUIRED",
    403,
    "Only the owning Organization Administrator or Tenant Administrator can change this Resource",
  )
}

function principalHasScope(principal: Principal, allowed: readonly string[]): boolean {
  return principal.scopes === undefined || allowed.some((scope) => principal.scopes!.includes(scope))
}

export function principalHasManagementScope(principal: Principal): boolean {
  return principalHasScope(principal, [MANAGEMENT_SCOPE])
}

function assertPrincipalScope(principal: Principal, allowed: readonly string[]): void {
  if (principalHasScope(principal, allowed)) return
  throw new PlatformApiError(
    "INSUFFICIENT_SCOPE",
    403,
    `One of the required OAuth scopes is missing: ${allowed.join(", ")}`,
  )
}

function assertBodyActor(
  body: unknown,
  field: "requested_by" | "reviewer_id",
  principal: Principal,
): Record<string, unknown> {
  const normalized = isRecord(body) ? { ...body } : {}
  const supplied = normalized[field]
  if (supplied !== undefined && supplied !== principal.subject_id) {
    throw new PlatformApiError(
      "ACTOR_SPOOFED",
      403,
      `${field} must be supplied by the authenticated principal`,
    )
  }
  normalized[field] = principal.subject_id
  return normalized
}

function isModelRoutingResolve(route: TenantRoute, method: string): boolean {
  return method === "POST" &&
    route.rest.length === 2 &&
    route.rest[0] === "model-routing" &&
    route.rest[1] === "resolve"
}

function isFederationTokenExchange(route: TenantRoute, method: string): boolean {
  return method === "POST" &&
    route.rest.length === 2 &&
    route.rest[0] === "sts" &&
    route.rest[1] === "token-exchange"
}

function isTenantMutation(route: TenantRoute, method: string): boolean {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) return false
  return !isModelRoutingResolve(route, method)
}

function isPublicationReview(route: TenantRoute): boolean {
  return route.rest.length === 5 &&
    route.rest[0] === "resources" &&
    route.rest[2] === "publication-requests" &&
    route.rest[4] === "review"
}

function isRuntimeControlTransport(route: TenantRoute, method: string): boolean {
  if (
    route.rest[0] !== "runtime-control" ||
    route.rest[1] !== "GATEWAY" ||
    !route.rest[2]
  ) return false
  if (
    method === "PUT" &&
    route.rest.length === 4 &&
    route.rest[3] === "capabilities"
  ) return true
  if (
    method === "PUT" &&
    route.rest.length === 5 &&
    route.rest[3] === "aggregate" &&
    route.rest[4] === "heartbeat"
  ) return true
  if (method === "POST") {
    return (
      route.rest.length === 4 &&
      (
        route.rest[3] === "activities" ||
        route.rest[3] === "audit-events" ||
        route.rest[3] === "accounting" ||
        route.rest[3] === "connection-health-observations"
      )
    ) || (
      route.rest.length === 5 &&
      route.rest[3] === "aggregate" &&
      route.rest[4] === "reports"
    ) || (
      route.rest.length === 7 &&
      route.rest[3] === "operations" &&
      route.rest[4] === "mcp-discovery" &&
      route.rest[6] === "result"
    )
  }
  if (method !== "GET") return false
  return (
    route.rest.length === 4 &&
    route.rest[3] === "connection-health-targets"
  ) || (
    route.rest.length === 5 &&
    route.rest[3] === "mcp-oauth" &&
    route.rest[4] === "headers"
  ) || (
    route.rest.length === 6 &&
    route.rest[3] === "operations" &&
    route.rest[4] === "mcp-discovery" &&
    route.rest[5] === "next"
  ) || (
    route.rest.length === 7 &&
    route.rest[3] === "operations" &&
    route.rest[4] === "mcp-discovery" &&
    route.rest[6] === "credential"
  ) || (
    route.rest.length === 6 &&
    route.rest[3] === "aggregate" &&
    route.rest[4] === "commands" &&
    route.rest[5] === "next"
  ) || (
    route.rest.length === 5 &&
    route.rest[3] === "aggregate" &&
    route.rest[4] === "connect"
  ) || (
    route.rest.length === 7 &&
    route.rest[3] === "aggregate" &&
    route.rest[4] === "releases" &&
    route.rest[6] === "package"
  )
}

function isConnectionHealthObservation(route: TenantRoute, method: string): boolean {
  return method === "POST" &&
    route.rest.length === 5 &&
    route.rest[0] === "resources" &&
    route.rest[2] === "connections" &&
    route.rest[4] === "health-observations"
}

function isInstalledConnectionLifecycleToggle(
  route: TenantRoute,
  method: string,
  resource: { installation_owned?: boolean } | null,
  body: unknown,
): boolean {
  if (
    method !== "POST" ||
    route.rest.length !== 5 ||
    route.rest[0] !== "resources" ||
    route.rest[2] !== "connections" ||
    route.rest[4] !== "lifecycle" ||
    resource?.installation_owned !== true
  ) return false
  return isRecord(body) && (body.command === "ENABLE" || body.command === "DISABLE")
}

function isRuntimeSelfRegistration(route: TenantRoute, method: string): boolean {
  return method === "PUT" &&
    route.rest.length === 4 &&
    route.rest[0] === "runtime-control" &&
    route.rest[1] === "GATEWAY" &&
    Boolean(route.rest[2]) &&
    route.rest[3] === "registration"
}

function isEndpointRuntimeTransport(route: TenantRoute, method: string): boolean {
  if (method === "GET" && route.rest.length === 4 && route.rest[0] === "runtime-control" && route.rest[1] === "ENDPOINT" && route.rest[3] === "connect") return true
  if (method !== "POST" || route.rest[0] !== "endpoints") return false
  if (route.rest.length === 2 && route.rest[1] === "enroll") return true
  return route.rest.length === 3 &&
    Boolean(route.rest[1]) &&
    ["heartbeat", "enforcements", "ai-activities", "rotate-credential"].includes(route.rest[2]!)
}

function isInvocationRoute(route: TenantRoute, method: string): boolean {
  if (route.rest.length === 2 && route.rest[0] === "discovery" && route.rest[1] === "mcp") return true
  if (method === "POST" && route.rest.length === 2 && route.rest[0] === "me" && route.rest[1] === "agents") return true
  if (route.rest[0] === "me" && route.rest[1] === "resource-connections") {
    return (method === "GET" && route.rest.length === 3) ||
      (method === "POST" && route.rest.length === 5 && ["authorize", "password"].includes(route.rest[4]!)) ||
      (method === "DELETE" && route.rest.length === 4)
  }
  if (method === "GET" && route.rest.length === 0) return true
  if (method === "GET" && route.rest[0] === "self-service-configuration") return true
  if (method === "GET" && (route.rest[0] === "catalog" || route.rest[0] === "me")) return true
  if (method === "GET" && route.rest[0] === "one-policy" && route.rest[1] === "bot-access") return true
  if (method === "GET" && route.rest[0] === "one-policy" && route.rest[1] === "runtime-effective") return true
  if (isManagementOnlyKnowledgeCandidateRoute(route, method)) return false
  if (method === "GET" && route.rest[0] === "knowledge-candidates") return true
  if (method === "GET" && route.rest[0] === "distillation-markers") return true
  if (method === "GET" && route.rest[0] === "team-workspaces") return true
  if (method !== "POST") return false
  if (route.rest[0] === "one-policy" && ["runtime-authorize", "runtime-report"].includes(route.rest[1] ?? "")) return true
  if (route.rest[0] === "resource-onboarding-requests") return true
  if (route.rest[0] === "invocations" && route.rest[1] === "authorize") return true
  return route.rest[0] === "access-requests" &&
    (route.rest.length === 1 || (route.rest.length === 3 && route.rest[2] === "cancel"))
}

function isManagementOnlyKnowledgeCandidateRoute(route: TenantRoute, method: string): boolean {
  return method === "GET" &&
    route.rest.length === 3 &&
    route.rest[0] === "knowledge-candidates" &&
    (route.rest[2] === "review-context" || route.rest[2] === "evidence")
}

function isFirstPartyBotSeedMutation(route: TenantRoute, method: string): boolean {
  return method !== "GET" &&
    route.rest[0] === "one-policy" &&
    route.rest[1] === "first-party-bot"
}

function isUseCaseCatalogRead(route: TenantRoute, method: string): boolean {
  return method === "GET" && route.rest.length === 3 && route.rest[0] === "organizations" && route.rest[2] === "use-cases"
}

function isDistillationBotCancellation(route: TenantRoute, method: string): boolean {
  return method === "DELETE" &&
    route.rest.length === 3 &&
    route.rest[0] === "distillation-markers" &&
    route.rest[1] === "bots" &&
    Boolean(route.rest[2])
}

function requiredRouteScopes(route: TenantRoute, method: string): readonly string[] {
  if (isDistillationBotCancellation(route, method)) return [MANAGEMENT_SCOPE, INVOCATION_SCOPE]
  if (method === "POST" && route.rest[0] === "distillation-markers") return [INVOCATION_SCOPE]
  if (isManagementOnlyKnowledgeCandidateRoute(route, method)) return [MANAGEMENT_SCOPE]
  if (isEndpointRuntimeTransport(route, method)) return [ENDPOINT_RUNTIME_SCOPE]
  if (method === "POST" && route.rest.length === 2 && route.rest[0] === "endpoints" && route.rest[1] === "bootstrap") return [MANAGEMENT_SCOPE, INVOCATION_SCOPE]
  if (isRuntimeControlTransport(route, method) || isRuntimeSelfRegistration(route, method) || isConnectionHealthObservation(route, method)) {
    return [GATEWAY_RUNTIME_SCOPE]
  }
  if (isUseCaseCatalogRead(route, method)) return [MANAGEMENT_SCOPE, INVOCATION_SCOPE]
  if (isInvocationRoute(route, method)) return [MANAGEMENT_SCOPE, INVOCATION_SCOPE]
  return [MANAGEMENT_SCOPE]
}

export function createManagementAuthorization(
  options: ManagementAuthorizationOptions,
): ManagementAuthorizationModule {
  const endpointIdentities = new WeakMap<object, EndpointCredentialIdentity>()
  const authorizeGatewayRuntime = async ({
    tenantId,
    runtimeId,
    request,
  }: {
    tenantId: string
    runtimeId: string
    request: { principal?: Principal }
  }) => {
    const principal = request.principal
    if (!principal) {
      throw new PlatformApiError("UNAUTHENTICATED", 401, "Runtime bearer token rejected")
    }
    const registration = await options.runtimeControl.getGatewayRuntime({
      tenantId,
      runtimeKind: "GATEWAY",
      runtimeId,
    })
    if (!registration || registration.status !== "ACTIVE") {
      throw new PlatformApiError("RUNTIME_RUNTIME_NOT_ACTIVE", 403)
    }
    if (principal.client_id !== registration.oidc_client_id) {
      throw new PlatformApiError("RUNTIME_ACCESS_DENIED", 403)
    }
  }

  const authorizeEndpoint = async ({ tenantId, deviceId, request }: {
    tenantId: string
    deviceId: string
    request: { principal?: Principal }
  }) => {
    const identity = endpointIdentities.get(request)
    if (!identity || identity.tenantId !== tenantId || identity.deviceId !== deviceId) {
      throw new PlatformApiError("ENDPOINT_CREDENTIAL_REJECTED", 401)
    }
    return { subjectId: identity.subjectId, credentialId: identity.credentialId }
  }

  return {
    async authenticate(request) {
      const route = tenantRoute(request)
      if (!route || isFederationTokenExchange(route, request.method)) return
      const token = extractBearerToken(request.headers.authorization)
      if (!token) {
        throw new PlatformApiError(
          "UNAUTHENTICATED",
          401,
          "A bearer token is required for tenant-scoped Management API routes",
        )
      }
      if (isEndpointRuntimeTransport(route, request.method)) {
        const identity = await options.endpointRuntime.authenticateCredential({ tenantId: route.tenantId, token })
        const enrolling = route.rest[0] === "endpoints" && route.rest[1] === "enroll" && route.rest.length === 2
        const deviceId = route.rest[0] === "runtime-control" ? route.rest[2] : route.rest[1]
        if (!enrolling && (identity.kind !== "RUNTIME" || identity.deviceId !== deviceId)) {
          throw new PlatformApiError("ENDPOINT_CREDENTIAL_REJECTED", 401)
        }
        endpointIdentities.set(request, identity)
        return
      }
      if (token.startsWith("genio_endpoint_")) throw new PlatformApiError("ENDPOINT_CREDENTIAL_REJECTED", 401)
      let principal: Principal | null = null
      try {
        principal = normalizePrincipal(
          await options.principalAuthenticator.authenticate({
            token,
            tenantId: route.tenantId,
            request,
          }),
        )
      } catch {
        principal = null
      }
      if (!principal) {
        throw new PlatformApiError("UNAUTHENTICATED", 401, "Bearer token rejected")
      }
      if (principal.tenant_id !== route.tenantId) {
        throw new PlatformApiError(
          "TENANT_ACCESS_DENIED",
          403,
          "The authenticated principal cannot access this tenant",
        )
      }
      assertPrincipalScope(principal, requiredRouteScopes(route, request.method))
      request.principal = principal
    },

    async normalize(request) {
      const route = tenantRoute(request)
      if (!route || !request.principal) return
      if (
        request.method === "POST" &&
        route.rest.length === 3 &&
        route.rest[0] === "resources" &&
        route.rest[2] === "publication-requests"
      ) {
        request.body = assertBodyActor(request.body, "requested_by", request.principal)
      }
      if (isPublicationReview(route)) {
        request.body = assertBodyActor(request.body, "reviewer_id", request.principal)
      }
      if (!isModelRoutingResolve(route, request.method)) return
      const body = isRecord(request.body) ? request.body : {}
      if (body.subject_id !== undefined && body.subject_id !== request.principal.subject_id) {
        throw new PlatformApiError(
          "ACTOR_SPOOFED",
          403,
          "subject_id must match the authenticated principal",
        )
      }
      if (body.client_id !== undefined && body.client_id !== request.principal.client_id) {
        throw new PlatformApiError(
          "ACTOR_SPOOFED",
          403,
          "client_id must match the authenticated principal",
        )
      }
      if (!options.entitlementResolver) {
        throw new PlatformApiError(
          "ENTITLEMENT_RESOLVER_UNAVAILABLE",
          503,
          "Model routing is unavailable until an entitlement resolver is configured",
        )
      }
      let entitledModelIds: readonly string[]
      try {
        entitledModelIds = await options.entitlementResolver.resolve({
          tenantId: route.tenantId,
          subjectId: request.principal.subject_id,
          clientId: request.principal.client_id,
          ...(typeof body.public_model_id === "string"
            ? { publicModelId: body.public_model_id }
            : {}),
          ...(typeof body.requested_public_model_id === "string"
            ? { requestedModelId: body.requested_public_model_id }
            : {}),
        })
      } catch {
        throw new PlatformApiError(
          "ENTITLEMENT_RESOLUTION_FAILED",
          503,
          "The effective model entitlement could not be resolved",
        )
      }
      if (!Array.isArray(entitledModelIds)) {
        throw new PlatformApiError(
          "ENTITLEMENT_RESOLUTION_FAILED",
          503,
          "The effective model entitlement could not be resolved",
        )
      }
      const uniqueModelIds = [...new Set(entitledModelIds)].filter(
        (modelId): modelId is string => typeof modelId === "string" && modelId.length > 0,
      )
      if (uniqueModelIds.length === 0) {
        throw new PlatformApiError(
          "NO_ENTITLED_MODELS",
          403,
          "The authenticated principal has no model entitlement",
        )
      }
      const trustedBody = { ...body }
      delete trustedBody.entitled_model_ids
      delete trustedBody.entitled_public_model_ids
      request.body = {
        ...trustedBody,
        subject_id: request.principal.subject_id,
        client_id: request.principal.client_id,
        entitled_public_model_ids: uniqueModelIds,
      }
    },

    async authorize(request) {
      const route = tenantRoute(request)
      const principal = request.principal
      if (!route || !principal) return
      const resourceId = route.rest[0] === "resources" && route.rest[1] !== "import-openapi"
        ? route.rest[1]
        : undefined
      const resource = resourceId
        ? await options.resourceCatalog.getResource({
            tenantId: route.tenantId,
            resourceId,
            authorization: request.headers.authorization,
          })
        : null
      if (resource) request.routeResource = resource
      if (
        resource?.builtin_service &&
        !["GET", "HEAD"].includes(request.method) &&
        !isInstalledConnectionLifecycleToggle(route, request.method, resource, request.body)
      ) throw new PlatformApiError("BUILTIN_RESOURCE_MANAGED_BY_PLATFORM", 409)

      if (["traces", "logs"].includes(route.rest[0] ?? "")) {
        assertTenantAdministrator(principal)
        return
      }
      if (isPublicationReview(route)) {
        assertTenantAdministrator(principal)
        return
      }
      if (isFirstPartyBotSeedMutation(route, request.method)) {
        assertTenantAdministrator(principal)
        return
      }
      if (route.rest[0] === "one-policy" && route.rest[1] === "runtime-policies") {
        assertTenantAdministrator(principal)
        return
      }
      if (isRuntimeSelfRegistration(route, request.method)) {
        const runtimeId = route.rest[2]!
        if (principal.client_id !== runtimeId) {
          throw new PlatformApiError(
            "RUNTIME_SELF_REGISTRATION_DENIED",
            403,
            "A Gateway Runtime may register only its own authenticated runtime id",
          )
        }
        return
      }
      if (isConnectionHealthObservation(route, request.method)) return
      if (route.rest[0] === "runtime-control" && !isRuntimeControlTransport(route, request.method)) {
        assertTenantAdministrator(principal)
        return
      }
      if (["runtimes", "gateways", "gateway-sites", "gateway-groups", "gateway-rollbacks"].includes(route.rest[0] ?? "")) {
        assertTenantAdministrator(principal)
        return
      }
      if (["siem-destination", "siem-deliveries"].includes(route.rest[0] ?? "")) {
        assertTenantAdministrator(principal)
        return
      }
      if (route.rest[0] === "configuration-revisions") {
        assertTenantAdministrator(principal)
        return
      }
      if (
        route.rest[0] === "processor-adapters" &&
        request.method === "GET" &&
        route.rest.length === 1
      ) {
        if (principal.role === "USER") {
          throw new PlatformApiError(
            "POLICY_ADMINISTRATOR_REQUIRED",
            403,
            "Processor adapter metadata is available only to policy administrators",
          )
        }
        return
      }
      if (
        route.rest[0] === "activities" &&
        route.rest[2] === "outcomes" &&
        request.method === "POST"
      ) {
        assertTenantAdministrator(principal)
        return
      }
      if (
        route.rest[0] === "organizations" &&
        ((request.method === "POST" && route.rest.length === 1) ||
          (request.method === "PUT" && route.rest.length === 2))
      ) {
        assertTenantAdministrator(principal)
        return
      }
      if (
        route.rest[0] === "applications" &&
        route.rest.length === 1 &&
        request.method === "POST"
      ) {
        const body = isRecord(request.body) ? request.body : {}
        assertOrganizationManager(
          principal,
          typeof body.owner_organization_id === "string" ? body.owner_organization_id : null,
        )
        return
      }
      if (route.rest[0] === "providers" && request.method === "POST") {
        assertTenantAdministrator(principal)
        return
      }
      if (
        route.rest[0] === "entitlements" &&
        !(request.method === "POST" && route.rest.length === 3 && route.rest[2] === "revoke")
      ) {
        assertTenantAdministrator(principal)
        return
      }
      if (route.rest[0] === "identity") {
        if (request.method !== "GET" || principal.role === "USER") {
          assertTenantAdministrator(principal)
        }
        return
      }
      if (route.rest[0] === "access-groups") {
        assertTenantAdministrator(principal)
        return
      }
      // Login methods apply to the whole realm rather than to one Organization,
      // so reading and changing them stays with the Tenant Administrator.
      if (route.rest[0] === "identity-providers") {
        assertTenantAdministrator(principal)
        return
      }
      if (route.rest[0] === "demo-project") {
        if (principal.role === "USER") {
          throw new PlatformApiError(
            "RESOURCE_OWNER_OR_TENANT_ADMIN_REQUIRED",
            403,
            "Only an Organization Administrator or Tenant Administrator can manage a Demo Project",
          )
        }
        if (request.method === "POST" && route.rest[1] === "install") {
          const body = isRecord(request.body) ? request.body : {}
          assertOrganizationManager(
            principal,
            typeof body.organization_id === "string" ? body.organization_id : null,
          )
          return
        }
        if (!isTenantAdministrator(principal)) {
          try {
            const demo = await options.resourceCatalog.getResource({
              tenantId: route.tenantId,
              resourceId: "genio.demo.bot",
              authorization: request.headers.authorization,
            })
            assertOrganizationManager(principal, demo.owner_organization_id)
          } catch (error) {
            if (!(error instanceof PlatformApiError) || error.code !== "RESOURCE_NOT_FOUND") throw error
          }
        }
        return
      }
      if (route.rest[0] === "providers" && principal.role === "USER") {
        throw new PlatformApiError(
          "PROVIDER_PROFILE_MANAGEMENT_REQUIRED",
          403,
          "Provider profiles are available only to Organization or Tenant Administrators",
        )
      }
      if (
        route.rest[0] === "organizations" &&
        request.method === "GET" &&
        route.rest.length === 2 &&
        !isTenantAdministrator(principal) &&
        !principal.organization_ids.includes(route.rest[1])
      ) {
        throw new PlatformApiError(
          "ORGANIZATION_ACCESS_DENIED",
          403,
          "The authenticated principal cannot view this Organization",
        )
      }
      if (
        route.rest[0] === "organizations" &&
        route.rest.length === 3 &&
        route.rest[2] === "use-cases"
      ) {
        if (request.method === "GET") {
          if (!isTenantAdministrator(principal) && !principal.organization_ids.includes(route.rest[1]!)) {
            throw new PlatformApiError(
              "ORGANIZATION_ACCESS_DENIED",
              403,
              "The authenticated principal cannot view this Organization Use Case catalog",
            )
          }
          return
        }
        if (request.method === "POST") {
          assertOrganizationManager(principal, route.rest[1]!)
          return
        }
      }
      if (
        route.rest[0] === "resources" &&
        request.method === "POST" &&
        (route.rest.length === 1 || (route.rest.length === 2 && route.rest[1] === "import-openapi"))
      ) {
        const body = isRecord(request.body) ? request.body : {}
        assertOrganizationManager(
          principal,
          typeof body.owner_organization_id === "string"
            ? body.owner_organization_id
            : null,
        )
        return
      }
      if (resource) {
        assertOrganizationManager(principal, resource.owner_organization_id)
        if (
          route.rest[0] === "resources" &&
          route.rest.length === 2 &&
          request.method === "PATCH" &&
          isRecord(request.body) &&
          typeof request.body.owner_organization_id === "string" &&
          !isTenantAdministrator(principal)
        ) {
          assertOrganizationManager(principal, request.body.owner_organization_id)
        }
      }
      if (
        (route.rest[0] === "ai-gateway" || route.rest[0] === "model-routing") &&
        isTenantMutation(route, request.method)
      ) {
        assertTenantAdministrator(principal)
      }
    },

    authorizeGatewayRuntime,
    authorizeEndpoint,
  }
}
