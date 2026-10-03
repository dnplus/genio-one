import type { EndpointCredentialIdentity, EndpointRuntimeStore } from "../endpoint-runtime/module"
import type { FastifyRequest } from "fastify"
import { randomUUID } from "node:crypto"

import { PlatformApiError } from "../errors"
import type { GatewayAuthorizationAuditStore } from "../audit-events/module"
import { SYSTEM_AUDIT_TENANT_ID, type ManagementAuthorizationAuditEvent, type AuthenticationAttemptReceipt, type ManagementAuthorizationRequestContext } from "../audit-events/contract"
import type { ResourceCatalog } from "../resources/module"
import type { RuntimeControlStore } from "../runtime-control/contract"
import type {
  EntitlementResolver,
  Principal,
  PrincipalAuthenticator,
} from "../tenancy-auth/contract"
import { normalizePrincipal } from "../tenancy-auth/memory"
import {
  isRuntimeControlTransport,
  isRuntimeSelfRegistration,
  tenantRoute,
  type TenantRoute,
} from "../tenancy-auth/routes"

const MANAGEMENT_SCOPE = "genioone-management"
const INVOCATION_SCOPE = "genioone-invocation"
const GATEWAY_RUNTIME_SCOPE = "genioone-gateway-runtime"
const ENDPOINT_RUNTIME_SCOPE = "genioone-endpoint-runtime"

export interface ManagementAuthorizationOptions {
  principalAuthenticator: PrincipalAuthenticator
  entitlementResolver?: EntitlementResolver
  resourceCatalog: ResourceCatalog
  endpointRuntime: EndpointRuntimeStore
  runtimeControl: RuntimeControlStore
  auditEvents: GatewayAuthorizationAuditStore
}

export interface ManagementAuthorizationModule {
  authenticate(request: FastifyRequest): Promise<void>
  normalize(request: FastifyRequest): Promise<void>
  authorize(request: FastifyRequest): Promise<void>
  recordAuthenticationAttempt(request: FastifyRequest, input: {
    outcome: AuthenticationAttemptReceipt["outcome"]
    code: string
    verifiedTenantId?: string | null
    verifiedSubjectId?: string | null
    verifiedClientId?: string | null
  }): Promise<void>
  recordAuthorizationDecision(request: FastifyRequest, principal: Principal, outcome: ManagementAuthorizationAuditEvent["outcome"], code: string, context?: ManagementAuthorizationRequestContextInput): Promise<void>
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

export interface ManagementAuthorizationRequestContextInput {
  requestedTenantId?: string | null
  targetResourceId?: string | null
  targetOrganizationId?: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function extractBearerToken(value: string | undefined): string | null {
  if (!value) return null
  const match = /^Bearer\s+(\S+)$/i.exec(value.trim())
  return match?.[1] ?? null
}

function auditMethod(request: FastifyRequest): string {
  return /^[A-Z]+$/.test(request.method) && request.method.length <= 16
    ? request.method
    : "UNKNOWN"
}

function auditRoute(request: FastifyRequest): string {
  const route = request.routeOptions?.url
  return typeof route === "string" && route.startsWith("/") && route.length <= 512
    ? route
    : "UNRESOLVED"
}

function safeCorrelationId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)
    ? value
    : null
}

function auditCorrelationId(request: FastifyRequest): string {
  const incoming = request.headers?.["x-genio-correlation-id"]
  const headerValue = Array.isArray(incoming) ? null : safeCorrelationId(incoming)
  return headerValue ?? safeCorrelationId(request.id) ?? `platform-api-${randomUUID()}`
}

function auditCode(error: unknown): string {
  const code = error instanceof PlatformApiError ? error.code : "INTERNAL_ERROR"
  return /^[A-Z][A-Z0-9_:-]{0,127}$/.test(code) ? code : "INTERNAL_ERROR"
}

function contextIdentifier(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\\/\0\r\n]/.test(value)
    ? value
    : null
}

function requestContext(request: FastifyRequest, override: ManagementAuthorizationRequestContextInput = {}): ManagementAuthorizationRequestContext {
  const route = tenantRoute(request)
  const resourceId = route?.rest[0] === "resources" && route.rest[1] !== "import-openapi"
    ? contextIdentifier(route.rest[1])
    : null
  const organizationId = route?.rest[0] === "organizations" && route.rest.length >= 2
    ? contextIdentifier(route.rest[1])
    : null
  return {
    requested_tenant_id: override.requestedTenantId === undefined
      ? contextIdentifier(route?.tenantId)
      : contextIdentifier(override.requestedTenantId),
    target: {
      resource_id: override.targetResourceId === undefined ? resourceId : contextIdentifier(override.targetResourceId),
      organization_id: override.targetOrganizationId === undefined ? organizationId : contextIdentifier(override.targetOrganizationId),
    },
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
      principal.administrator_organization_ids?.includes(organizationId))
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
  return allowed.some((scope) => principal.scopes?.includes(scope) === true)
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

function isEndpointRuntimeTransport(route: TenantRoute, method: string): boolean {
  if (method === "GET" && route.rest.length === 4 && route.rest[0] === "runtime-control" && route.rest[1] === "ENDPOINT" && route.rest[3] === "connect") return true
  if (method !== "POST" || route.rest[0] !== "endpoints") return false
  if (route.rest.length === 2 && route.rest[1] === "enroll") return true
  return route.rest.length === 3 &&
    Boolean(route.rest[1]) &&
    ["heartbeat", "enforcements", "ai-activities", "rotate-credential"].includes(route.rest[2]!)
}

function isPostHogBrowserConfiguration(route: TenantRoute, method: string): boolean {
  return method === "GET" &&
    route.rest.length === 3 &&
    route.rest[0] === "telemetry" &&
    route.rest[1] === "posthog" &&
    route.rest[2] === "browser-configuration"
}

function isSharedMemoryRoute(
  route: TenantRoute,
  scope: "organizations" | "team-workspaces",
): boolean {
  if (route.rest[0] !== scope || !route.rest[1] || route.rest[2] !== "memories") return false
  if (route.rest.length === 3) return true
  if (route.rest.length === 4 && route.rest[3]) return true
  if (route.rest.length === 5 && route.rest[3] && route.rest[4] === "corrections") return true
  return route.rest.length === 7 &&
    Boolean(route.rest[3]) &&
    route.rest[4] === "corrections" &&
    Boolean(route.rest[5]) &&
    route.rest[6] === "review"
}

function isMemoryRoute(route: TenantRoute, method: string): boolean {
  if (route.rest.length === 2 && route.rest[0] === "memory" && route.rest[1] === "mcp") return true
  if (
    isSharedMemoryRoute(route, "team-workspaces") ||
    isSharedMemoryRoute(route, "organizations")
  ) return true
  if (route.rest[0] !== "me") return false
  if (route.rest[1] === "memories") return route.rest.length === 2 || route.rest.length === 3
  if (route.rest[1] === "memory-agents") return route.rest.length === 2 || route.rest.length === 3
  return method === "GET" && route.rest.length === 2 && route.rest[1] === "memory-scopes"
}

function isTeamWorkspaceRead(route: TenantRoute, method: string): boolean {
  return method === "GET" &&
    route.rest[0] === "team-workspaces" &&
    (route.rest.length === 1 || (route.rest.length === 2 && Boolean(route.rest[1])))
}

function assertMemoryInvocationScope(principal: Principal): void {
  if (principal.scopes?.includes(INVOCATION_SCOPE)) return
  throw new PlatformApiError(
    "INSUFFICIENT_SCOPE",
    403,
    `The required OAuth scope is missing: ${INVOCATION_SCOPE}`,
  )
}

function isInvocationRoute(route: TenantRoute, method: string): boolean {
  if (isPostHogBrowserConfiguration(route, method)) return true
  if (isMemoryRoute(route, method)) return true
  if (route.rest.length === 2 && route.rest[0] === "discovery" && route.rest[1] === "mcp") return true
  if (method === "POST" && route.rest.length === 2 && route.rest[0] === "me" && route.rest[1] === "agents") return true
  if (route.rest[0] === "me" && route.rest[1] === "resource-connections") {
    return (method === "GET" && route.rest.length === 3) ||
      (method === "POST" && route.rest.length === 5 && ["authorize", "password", "discovery"].includes(route.rest[4]!)) ||
      (method === "GET" && route.rest.length === 6 && route.rest[4] === "discovery") ||
      (method === "DELETE" && route.rest.length === 4)
  }
  if (method === "GET" && route.rest.length === 0) return true
  if (method === "GET" && route.rest[0] === "self-service-configuration") return true
  if (method === "GET" && (route.rest[0] === "catalog" || route.rest[0] === "me")) return true
  if (method === "GET" && route.rest[0] === "one-policy" && route.rest[1] === "bot-access") return true
  if (method === "GET" && route.rest[0] === "one-policy" && route.rest[1] === "runtime-effective") return true
  if (
    method === "POST" &&
    route.rest.length === 3 &&
    route.rest[0] === "me" &&
    route.rest[1] === "entitlements" &&
    route.rest[2] === "activate"
  ) return true
  if (isManagementOnlyKnowledgeCandidateRoute(route, method)) return false
  if (method === "GET" && route.rest[0] === "knowledge-candidates") return true
  if (method === "GET" && route.rest[0] === "distillation-markers") return true
  if (isTeamWorkspaceRead(route, method)) return true
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

function isAuditExportRead(route: TenantRoute, method: string): boolean {
  return (method === "GET" || method === "HEAD") && route.rest.length === 1 && route.rest[0] === "audit-export"
}

function isAuditEventListRead(route: TenantRoute, method: string): boolean {
  return (method === "GET" || method === "HEAD") && route.rest.length === 1 && route.rest[0] === "audit-events"
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
      await recordAuthenticationAttempt(request as FastifyRequest, {
        outcome: "FAILURE",
        code: "UNAUTHENTICATED",
      })
      throw new PlatformApiError("UNAUTHENTICATED", 401, "Runtime bearer token rejected")
    }
    try {
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
    } catch (error) {
      await recordAuthorizationDecision(request as FastifyRequest, principal, "DENY", auditCode(error))
      throw error
    }
    await recordAuthorizationDecision(request as FastifyRequest, principal, "ALLOW", "AUTHORIZED")
  }

  const authorizeEndpoint = async ({ tenantId, deviceId, request }: {
    tenantId: string
    deviceId: string
    request: { principal?: Principal }
  }) => {
    const identity = endpointIdentities.get(request)
    if (!identity || identity.tenantId !== tenantId || identity.deviceId !== deviceId) {
      await recordAuthenticationAttempt(request as FastifyRequest, {
        outcome: "FAILURE",
        code: "ENDPOINT_CREDENTIAL_REJECTED",
        ...(identity
          ? { verifiedTenantId: identity.tenantId, verifiedSubjectId: identity.subjectId }
          : {}),
      })
      throw new PlatformApiError("ENDPOINT_CREDENTIAL_REJECTED", 401)
    }
    return { subjectId: identity.subjectId, credentialId: identity.credentialId }
  }

  const recordAuthenticationAttempt = async (
    request: FastifyRequest,
    input: {
      outcome: AuthenticationAttemptReceipt["outcome"]
      code: string
      verifiedTenantId?: string | null
      verifiedSubjectId?: string | null
      verifiedClientId?: string | null
    },
  ): Promise<void> => {
    if (typeof options.auditEvents.recordAuthenticationAttempt !== "function") {
      throw new PlatformApiError("AUDIT_STORE_UNAVAILABLE", 503)
    }
    await options.auditEvents.recordAuthenticationAttempt({
      receipt: {
        authentication_attempt_id: `management-authn-${randomUUID()}`,
        correlation_id: auditCorrelationId(request),
        kind: "MANAGEMENT_AUTHENTICATION_ATTEMPT",
        scope: "SYSTEM",
        outcome: input.outcome,
        code: /^[A-Z][A-Z0-9_:-]{0,127}$/.test(input.code) ? input.code : "INTERNAL_ERROR",
        method: auditMethod(request),
        route: auditRoute(request),
        verified_tenant_id: input.verifiedTenantId ?? null,
        verified_subject_id: input.verifiedSubjectId ?? null,
        verified_client_id: input.verifiedClientId ?? null,
        occurred_at: Math.floor(Date.now() / 1_000),
      },
    })
  }

  const recordAuthorizationDecision = async (
    request: FastifyRequest,
    principal: Principal,
    outcome: ManagementAuthorizationAuditEvent["outcome"],
    code: string,
    context: ManagementAuthorizationRequestContextInput = {},
  ): Promise<void> => {
    const record = options.auditEvents?.record
    if (!record) throw new PlatformApiError("AUDIT_STORE_UNAVAILABLE", 503)
    await record({
      tenantId: principal.tenant_id,
      event: {
        tenant_id: principal.tenant_id,
        audit_event_id: `management-authz-${randomUUID()}`,
        correlation_id: auditCorrelationId(request),
        kind: "MANAGEMENT_AUTHORIZATION",
        outcome,
        subject: { subject_id: principal.subject_id, evidence_level: "VERIFIED" },
        acting_client: { acting_client_id: principal.client_id, evidence_level: "VERIFIED" },
        request_context: requestContext(request, context),
        code: /^[A-Z][A-Z0-9_:-]{0,127}$/.test(code) ? code : "INTERNAL_ERROR",
        method: auditMethod(request),
        route: auditRoute(request),
        occurred_at: Math.floor(Date.now() / 1_000),
      },
    })
  }

  return {
    recordAuthenticationAttempt,
    recordAuthorizationDecision,
    async authenticate(request) {
      const route = tenantRoute(request)
      if (!route || isFederationTokenExchange(route, request.method)) return
      const token = extractBearerToken(request.headers.authorization)
      if (!token) {
        await recordAuthenticationAttempt(request, {
          outcome: "FAILURE",
          code: "MISSING_BEARER_TOKEN",
        })
        throw new PlatformApiError(
          "UNAUTHENTICATED",
          401,
          "A bearer token is required for tenant-scoped Management API routes",
        )
      }
      if (isEndpointRuntimeTransport(route, request.method)) {
        let identity: EndpointCredentialIdentity
        try {
          identity = await options.endpointRuntime.authenticateCredential({ tenantId: route.tenantId, token })
        } catch (error) {
          await recordAuthenticationAttempt(request, {
            outcome: "FAILURE",
            code: auditCode(error),
          })
          throw error
        }
        const enrolling = route.rest[0] === "endpoints" && route.rest[1] === "enroll" && route.rest.length === 2
        const deviceId = route.rest[0] === "runtime-control" ? route.rest[2] : route.rest[1]
        if (!enrolling && (identity.kind !== "RUNTIME" || identity.deviceId !== deviceId)) {
          await recordAuthenticationAttempt(request, {
            outcome: "FAILURE",
            code: "ENDPOINT_CREDENTIAL_REJECTED",
            verifiedTenantId: identity.tenantId,
            verifiedSubjectId: identity.subjectId,
          })
          throw new PlatformApiError("ENDPOINT_CREDENTIAL_REJECTED", 401)
        }
        endpointIdentities.set(request, identity)
        await recordAuthenticationAttempt(request, {
          outcome: "SUCCESS",
          code: "ENDPOINT_CREDENTIAL_ACCEPTED",
          verifiedTenantId: identity.tenantId,
          verifiedSubjectId: identity.subjectId,
        })
        return
      }
      if (token.startsWith("genio_endpoint_")) {
        await recordAuthenticationAttempt(request, {
          outcome: "FAILURE",
          code: "ENDPOINT_CREDENTIAL_REJECTED",
        })
        throw new PlatformApiError("ENDPOINT_CREDENTIAL_REJECTED", 401)
      }
      let principal: Principal | null = null
      try {
        principal = normalizePrincipal(
          await options.principalAuthenticator.authenticate({
            token,
            tenantId: route.tenantId,
            request,
          }),
        )
      } catch (error) {
        await recordAuthenticationAttempt(request, {
          outcome: "FAILURE",
          code: error instanceof PlatformApiError ? auditCode(error) : "AUTHENTICATION_BACKEND_FAILURE",
        })
        throw error
      }
      if (!principal) {
        await recordAuthenticationAttempt(request, {
          outcome: "FAILURE",
          code: "UNAUTHENTICATED",
        })
        throw new PlatformApiError("UNAUTHENTICATED", 401, "Bearer token rejected")
      }
      request.principal = principal
      await recordAuthenticationAttempt(request, {
        outcome: "SUCCESS",
        code: "AUTHENTICATED",
        verifiedTenantId: principal.tenant_id,
        verifiedSubjectId: principal.subject_id,
        verifiedClientId: principal.client_id,
      })
      if (principal.tenant_id !== route.tenantId) {
        await recordAuthorizationDecision(request, principal, "DENY", "TENANT_ACCESS_DENIED")
        throw new PlatformApiError(
          "TENANT_ACCESS_DENIED",
          403,
          "The authenticated principal cannot access this tenant",
        )
      }
      if (route.tenantId === SYSTEM_AUDIT_TENANT_ID) {
        await recordAuthorizationDecision(request, principal, "DENY", "SYSTEM_SCOPE_RESERVED")
        throw new PlatformApiError("TENANT_ACCESS_DENIED", 403)
      }
      try {
        assertPrincipalScope(principal, requiredRouteScopes(route, request.method))
        if (isMemoryRoute(route, request.method)) assertMemoryInvocationScope(principal)
        if (isAuditExportRead(route, request.method)) {
          assertPrincipalScope(principal, ["audit.export"])
        }
        if (request.method === "POST" && route.rest.length === 1 && route.rest[0] === "applications") {
          assertPrincipalScope(principal, ["application.create"])
        }
      } catch (error) {
        await recordAuthorizationDecision(request, principal, "DENY", auditCode(error))
        throw error
      }
    },

    async normalize(request) {
      const route = tenantRoute(request)
      const principal = request.principal
      if (!route || !principal) return
      const run = async () => {
        if (
          request.method === "POST" &&
          route.rest.length === 3 &&
          route.rest[0] === "resources" &&
          route.rest[2] === "publication-requests"
        ) {
          request.body = assertBodyActor(request.body, "requested_by", principal)
        }
        if (isPublicationReview(route)) {
          request.body = assertBodyActor(request.body, "reviewer_id", principal)
        }
        if (!isModelRoutingResolve(route, request.method)) return
        const body = isRecord(request.body) ? request.body : {}
        if (body.subject_id !== undefined && body.subject_id !== principal.subject_id) {
          throw new PlatformApiError(
            "ACTOR_SPOOFED",
            403,
            "subject_id must match the authenticated principal",
          )
        }
        if (body.client_id !== undefined && body.client_id !== principal.client_id) {
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
            subjectId: principal.subject_id,
            clientId: principal.client_id,
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
          subject_id: principal.subject_id,
          client_id: principal.client_id,
          entitled_public_model_ids: uniqueModelIds,
        }
      }
      try {
        await run()
      } catch (error) {
        await recordAuthorizationDecision(request, principal, "DENY", auditCode(error))
        throw error
      }
    },

    async authorize(request) {
      const route = tenantRoute(request)
      const principal = request.principal
      if (!route || !principal) return
      const run = async () => {
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
      if (isAuditExportRead(route, request.method)) {
        assertTenantAdministrator(principal)
        return
      }
      if (isAuditEventListRead(route, request.method)) {
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
        request.method === "POST" &&
        route.rest.length === 1
      ) {
        assertTenantAdministrator(principal)
        return
      }
      if (
        route.rest[0] === "organizations" &&
        request.method === "PUT" &&
        route.rest.length === 2
      ) {
        assertOrganizationManager(principal, route.rest[1] ?? null)
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
        if (principal.role === "USER") assertTenantAdministrator(principal)
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
        if (["GET", "HEAD"].includes(request.method) && route.rest.length === 2) {
          if (!isTenantAdministrator(principal) && !principal.organization_ids.includes(resource.owner_organization_id)) {
            throw new PlatformApiError("ORGANIZATION_ACCESS_DENIED", 403)
          }
        } else {
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
      }
        if (
          (route.rest[0] === "ai-gateway" || route.rest[0] === "model-routing") &&
          isTenantMutation(route, request.method)
        ) {
          assertTenantAdministrator(principal)
        }
      }
      try {
        await run()
      } catch (error) {
        await recordAuthorizationDecision(request, principal, "DENY", auditCode(error))
        throw error
      }
      if (!isRuntimeControlTransport(route, request.method)) {
        await recordAuthorizationDecision(request, principal, "ALLOW", "AUTHORIZED")
      }
    },

    authorizeGatewayRuntime,
    authorizeEndpoint,
  }
}
