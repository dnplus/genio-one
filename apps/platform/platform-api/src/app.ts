import { endpointRuntimeWebSocket } from "./capabilities/endpoint-runtime/websocket"
import { registerBrowserTelemetry } from "@genioone/telemetry/browser-telemetry-http"
import { instrumentModuleGraph } from "@genioone/telemetry/operation-observability"
import { registerHttpObservability } from "@genioone/telemetry/fastify-observability"
import { permissionPreviewHttp } from "./capabilities/one-policy/permission-preview"
import { accessGroupHttp } from "./capabilities/access-groups/http"
import { discoveryMcpHttp } from "./capabilities/discovery-mcp/http"
import type { InstalledConnectorDeployment } from "./capabilities/connections/installed-connectors"
import swagger from "@fastify/swagger"
import swaggerUi from "@fastify/swagger-ui"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"
import websocket from "@fastify/websocket"
import Fastify from "fastify"
import { Type } from "typebox"

import { resourceHttp } from "./capabilities/resources/http"
import type { ResourceCatalog } from "./capabilities/resources/module"
import { organizationHttp } from "./capabilities/organizations/http"
import { connectionHttp } from "./capabilities/connections/http"
import { providerHttp } from "./capabilities/providers/http"
import { providerCredentialProfileHttp } from "./capabilities/provider-credentials/http"
import { modelHttp } from "./capabilities/models/http"
import { modelRoutingHttp } from "./capabilities/model-routing/http"
import { enforcementHttp } from "./capabilities/enforcement/http"
import { gatewayProjectionHttp } from "./capabilities/gateway-projection/http"
import { publicationWorkflowHttp } from "./capabilities/publications/http"
import { modelEntitlementHttp } from "./capabilities/entitlements/http"
import type { PlatformModuleGraph } from "./capabilities/platform-modules"
import { isPlatformApiError, PlatformApiError } from "./capabilities/errors"
import type {
  EntitlementResolver,
  Principal,
  PrincipalAuthenticator,
} from "./capabilities/tenancy-auth/contract"
import { normalizePrincipal } from "./capabilities/tenancy-auth/memory"
import { createManagementAuthorization } from "./capabilities/management-authorization/module"
import { runtimeControlHttp } from "./capabilities/runtime-control/http"
import { gatewayAggregateRuntimeControlHttp } from "./capabilities/gateway-runtime-control/http"
import { mcpDiscoveryHttp } from "./capabilities/mcp-discovery/http"
import { mcpOAuthHttp } from "./capabilities/mcp-oauth/http"
import { personalConnectionHttp } from "./capabilities/mcp-oauth/personal-http"
import { gatewayActivityHttp } from "./capabilities/activities/http"
import { endpointActivityHttp } from "./capabilities/endpoint-activities/http"
import { endpointRuntimeHttp } from "./capabilities/endpoint-runtime/http"
import { traceHttp } from "./capabilities/traces/http"
import { gatewayMetricsHttp } from "./capabilities/metrics/http"
import { identityHttp } from "./capabilities/identity/http"
import { identityProviderHttp } from "./capabilities/identity-providers/http"
import type { IdentityProviderRegistry } from "./capabilities/identity-providers/module"
import type { SubjectSessionControl } from "./capabilities/identity/keycloak"
import { gatewayAuthorizationAuditHttp } from "./capabilities/audit-events/http"
import { applicationHttp } from "./capabilities/applications/http"
import { runtimeInventoryHttp } from "./capabilities/runtime-inventory/http"
import { siemHttp } from "./capabilities/siem/http"
import { notificationHttp } from "./capabilities/notifications/http"
import { configurationHttp } from "./capabilities/configuration/http"
import {
  PublicLoginBrandingSchema,
  type PublicLoginBranding,
} from "./capabilities/configuration/contract"
import { publicLoginBrandingFromConfiguration } from "./capabilities/configuration/branding"
import { accessHttp } from "./capabilities/access/http"
import { gatewayDiagnosticSettingsHttp } from "./capabilities/gateway-settings/http"
import { gatewayRegistrationHttp } from "./capabilities/gateway-registration/http"
import { usageGovernanceHttp } from "./capabilities/usage-governance/http"
import { agentDelegationHttp } from "./capabilities/agent-delegations/http"
import { federationHttp } from "./capabilities/federation/http"
import { executionGrantHttp } from "./capabilities/execution-grants/http"
import { onePolicyHttp } from "./capabilities/one-policy/http"
import { demoProjectHttp } from "./capabilities/demo-project/http"
import { DemoProjectService } from "./capabilities/demo-project/service"
import { prepareDemoLlm } from "./capabilities/demo-project/llm-provisioning"
import { prepareDemoMcp, type DemoMcpGatewayIdentity, type DemoMcpPublicationTarget } from "./capabilities/demo-project/provisioning"

const BROWSER_IDENTITY_SCOPES = ["genioone-management", "genioone-invocation"] as const

export interface ManagementApiDependencies {
  connectorDeployment?: InstalledConnectorDeployment
  /** One coherent graph; production must never compose implicit memory fallbacks. */
  modules: PlatformModuleGraph
  resourceCatalog: ResourceCatalog
  /** The only trust boundary for Management API caller identity. */
  principalAuthenticator: PrincipalAuthenticator
  /** Resolves effective model entitlements; absence fails model routing closed. */
  entitlementResolver?: EntitlementResolver
  /** Bundled images provide Swagger UI assets explicitly; source mode uses the package default. */
  swaggerUiStaticDir?: string
  /** The production image serves the same single-file React bundle at both product entry points. */
  webHtml?: string
  browserIdentity?: {
    tenant_id: string
    issuer: string
    authorization_endpoint: string
    token_endpoint: string
    client_id: string
    scopes: string[]
    management_client_id: string
    management_scopes: string[]
  }
  /** Absent when no Keycloak Admin credential is configured; login-method routes stay unregistered. */
  identityProviders?: IdentityProviderRegistry
  /** Mirrors Subject suspension into the identity provider when configured. */
  subjectSessionControl?: SubjectSessionControl
  logger?: boolean
  demoProjectArchifyEndpoint?: string
  demoProjectArchifyCredentialRef?: string
  demoProjectGeminiCredentialRef?: string
  demoProjectBotUrl?: string | null
  demoProjectGatewayId?: string
  demoProjectGatewayIdentity?: DemoMcpGatewayIdentity
  demoProjectMcpPublicationTarget?: DemoMcpPublicationTarget
}

function extractBearerToken(value: string | undefined): string | null {
  if (!value) return null
  const match = /^Bearer\s+(\S+)$/i.exec(value.trim())
  return match?.[1] ?? null
}

function originFromUrl(value: string): string | null {
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

function assertBrowserPrincipalScope(principal: Principal): void {
  if (principal.scopes === undefined) return
  if (BROWSER_IDENTITY_SCOPES.some((scope) => principal.scopes!.includes(scope))) return
  throw new PlatformApiError(
    "INSUFFICIENT_SCOPE",
    403,
    `One of the required OAuth scopes is missing: ${BROWSER_IDENTITY_SCOPES.join(", ")}`,
  )
}

export async function createManagementApi(dependencies: ManagementApiDependencies) {
  const app = Fastify({ logger: dependencies.logger ?? false }).withTypeProvider<TypeBoxTypeProvider>()
  registerHttpObservability(app, "genio-one-platform-api")
  instrumentModuleGraph(dependencies.modules as unknown as Record<string, unknown>, "genio-one-platform-api")
  const resourceRegistry = dependencies.modules.resources
  const principalAuthenticator = dependencies.principalAuthenticator
  const authorization = createManagementAuthorization({
    principalAuthenticator,
    ...(dependencies.entitlementResolver ? { entitlementResolver: dependencies.entitlementResolver } : {}),
    resourceCatalog: dependencies.resourceCatalog,
    runtimeControl: dependencies.modules.runtimeControl,
    endpointRuntime: dependencies.modules.endpointRuntime,
  })
  const authorizeGatewayRuntime = authorization.authorizeGatewayRuntime
  const authorizeEndpoint = authorization.authorizeEndpoint
  const demoProjectGatewayIdentity = dependencies.demoProjectGatewayIdentity
  const prepareMcp = demoProjectGatewayIdentity
    ? async (input: Parameters<NonNullable<ConstructorParameters<typeof DemoProjectService>[0]["prepareMcp"]>>[0]) => {
        const policy = await dependencies.modules.botAccessPolicy.getFirstPartyBotSeed({
          tenantId: input.tenantId,
        })
        return prepareDemoMcp({
          ...input,
          modules: {
            resources: dependencies.modules.resources,
            connections: dependencies.modules.connections,
            mcpDiscovery: dependencies.modules.mcpDiscovery,
            enforcementCompiler: dependencies.modules.enforcementCompiler,
            enforcementRevisions: dependencies.modules.enforcementRevisionStore,
            publicationWorkflow: dependencies.modules.publicationWorkflow,
            entitlements: dependencies.modules.entitlements,
            gatewayRegistrations: dependencies.modules.gatewayRegistrations,
            runtimeControl: dependencies.modules.runtimeControl,
          },
          gatewayIdentity: demoProjectGatewayIdentity,
          ...(dependencies.demoProjectMcpPublicationTarget
            ? { publicationTarget: { ...dependencies.demoProjectMcpPublicationTarget, basePath: `/mcp/${input.resourceId}` } }
            : {}),
          initialOnePolicyRevision: policy.policy_revision,
        })
      }
    : undefined
  const prepareLlm = demoProjectGatewayIdentity
    ? async (input: Parameters<NonNullable<ConstructorParameters<typeof DemoProjectService>[0]["prepareLlm"]>>[0]) => {
        const policy = await dependencies.modules.botAccessPolicy.getFirstPartyBotSeed({
          tenantId: input.tenantId,
        })
        return prepareDemoLlm({
          ...input,
          modules: {
            resources: dependencies.modules.resources,
            connections: dependencies.modules.connections,
            models: dependencies.modules.models,
            modelRoutingPolicies: dependencies.modules.modelRoutingPolicies,
            enforcementCompiler: dependencies.modules.enforcementCompiler,
            enforcementRevisions: dependencies.modules.enforcementRevisionStore,
            publicationWorkflow: dependencies.modules.publicationWorkflow,
            entitlements: dependencies.modules.entitlements,
            gatewayRegistrations: dependencies.modules.gatewayRegistrations,
            runtimeControl: dependencies.modules.runtimeControl,
          },
          gatewayIdentity: demoProjectGatewayIdentity,
          ...(dependencies.demoProjectMcpPublicationTarget
            ? { publicationTarget: dependencies.demoProjectMcpPublicationTarget }
            : {}),
          initialOnePolicyRevision: policy.policy_revision,
        })
      }
    : undefined
  const demoProject = new DemoProjectService({
    organizations: dependencies.modules.organizations,
    resources: dependencies.modules.resources,
    connections: dependencies.modules.connections,
    entitlements: dependencies.modules.entitlements,
    providerCredentials: dependencies.modules.providerCredentials,
    usageGovernance: dependencies.modules.usageGovernance,
    runtimePolicies: dependencies.modules.botAccessPolicy,
    installations: dependencies.modules.demoInstallations,
    gatewayId: dependencies.demoProjectGatewayId ?? "genio-ai-mcp-gateway",
    archifyEndpoint: dependencies.demoProjectArchifyEndpoint ?? "http://127.0.0.1:5193/mcp",
    archifyCredentialRef: dependencies.demoProjectArchifyCredentialRef ?? null,
    geminiCredentialRef: dependencies.demoProjectGeminiCredentialRef ?? null,
    botUrl: dependencies.demoProjectBotUrl ?? null,
    ...(prepareMcp ? { prepareMcp } : {}),
    ...(prepareLlm ? { prepareLlm } : {}),
  })

  // WebSocket support must be installed before any websocket route is
  // declared; the runtime-control plugin deliberately does not own the server.
  await app.register(websocket)

  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "GenioOne Product API",
        description:
          "Versioned product contracts used by the GenioOne Management UI and approved integrations.",
        version: "0.1.0",
      },
      tags: [
        { name: "Organizations", description: "Resource owner organizations" },
        { name: "Resources", description: "Governed Resource catalog" },
        { name: "Connections", description: "Provider Connections owned by a Resource" },
        { name: "Providers", description: "AI provider profiles" },
        { name: "Models", description: "Public AI model catalog" },
        { name: "Model Routing", description: "Session-scoped model route leases" },
        { name: "AI Gateway", description: "Native Envoy AI Gateway projections" },
        { name: "Publications", description: "Reviewed, signed Resource publication builds" },
        { name: "One Policy", description: "Ordered enforcement-chain compilation" },
        { name: "Entitlements", description: "Identity-to-Public-Model access grants" },
        { name: "Runtime Control", description: "Signed Gateway projection delivery and observed state" },
        { name: "Endpoint Activity", description: "Authenticated Endpoint observations" },
        { name: "Endpoint Runtime", description: "Endpoint enrollment and desired-state synchronization" },
      ],
    },
  })
  await app.register(swaggerUi, {
    routePrefix: "/docs",
    ...(dependencies.swaggerUiStaticDir
      ? { baseDir: dependencies.swaggerUiStaticDir }
      : {}),
    // Supplying the logo prevents the plugin from resolving a source-tree
    // asset path that does not exist inside a single-file Bun bundle.
    logo: {
      type: "image/svg+xml",
      content: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#087f8c"/><path fill="white" d="M16 8a8 8 0 1 0 0 16c2.4 0 4.5-1 6-2.6v-6.2h-6.4v3h3.2v1.7A5 5 0 1 1 21 16h3a8 8 0 0 0-8-8Z"/></svg>',
      ),
    },
  })

  app.get(
    "/healthz",
    {
      schema: {
        operationId: "getManagementApiHealth",
        tags: ["Operations"],
        response: {
          200: Type.Object({
            status: Type.Literal("ok"),
            component: Type.Literal("genio-one-platform-api"),
            api_mode: Type.String(),
          }),
        },
      },
    },
    async () => ({
      status: "ok" as const,
      component: "genio-one-platform-api" as const,
      api_mode: process.env.GENIO_ONE_PLATFORM_API_MODE ?? "unknown",
    }),
  )

  if (dependencies.webHtml) {
    const sendWeb = async (_request: unknown, reply: { type(value: string): { send(value: string): unknown } }) =>
      reply.type("text/html; charset=utf-8").send(dependencies.webHtml!)
    app.get("/", { schema: { hide: true } }, async (_request, reply) => {
      return reply.redirect("/management", 302)
    })
    app.get("/management", { schema: { hide: true } }, sendWeb)
    app.get("/management/", { schema: { hide: true } }, sendWeb)
    app.get("/self-service", { schema: { hide: true } }, sendWeb)
    app.get("/self-service/", { schema: { hide: true } }, sendWeb)
  }

  app.get(
    "/openapi.json",
    { schema: { hide: true } },
    async () => app.swagger(),
  )

  if (dependencies.browserIdentity) {
    const browserIdentity = dependencies.browserIdentity
    app.get(
      "/v1/identity/browser-configuration",
      async () => ({
        issuer: browserIdentity.issuer,
        authorization_endpoint: browserIdentity.authorization_endpoint,
        token_endpoint: browserIdentity.token_endpoint,
        client_id: browserIdentity.client_id,
        scopes: browserIdentity.scopes,
        management_client_id: browserIdentity.management_client_id,
        management_scopes: browserIdentity.management_scopes,
      }),
    )
    app.get("/v1/identity/login-branding", {
      schema: {
        operationId: "getLoginBranding",
        tags: ["Identity"],
        response: { 200: PublicLoginBrandingSchema },
      },
    }, async (request, reply) => {
      const published = await dependencies.modules.configuration.published({
        tenantId: browserIdentity.tenant_id,
      })
      const branding: PublicLoginBranding = publicLoginBrandingFromConfiguration(published?.settings)
      const identityOrigin = originFromUrl(browserIdentity.authorization_endpoint)
      if (request.headers.origin && request.headers.origin === identityOrigin) {
        reply.header("access-control-allow-origin", identityOrigin)
        reply.header("vary", "Origin")
      }
      return reply.header("cache-control", "no-store").send(branding)
    })
    app.get("/v1/identity/session", async (request) => {
      const token = extractBearerToken(request.headers.authorization)
      if (!token) throw new PlatformApiError("UNAUTHENTICATED", 401)
      const principal = normalizePrincipal(
        await principalAuthenticator.authenticate({
          token,
          tenantId: browserIdentity.tenant_id,
          request,
        }),
      )
      if (!principal) throw new PlatformApiError("UNAUTHENTICATED", 401)
      assertBrowserPrincipalScope(principal)
      return {
        tenant_id: principal.tenant_id,
        subject_id: principal.subject_id,
        display_name: principal.display_name ?? null,
        email: principal.email ?? null,
        acting_client_id: principal.client_id,
        role: principal.role,
        organization_ids: principal.organization_ids,
        scopes: principal.scopes ?? browserIdentity.management_scopes,
        acr: "oidc",
        amr: ["oidc"],
      }
    })
  }

  app.setErrorHandler((error, _request, reply) => {
    if (
      typeof error === "object" &&
      error !== null &&
      "validation" in error &&
      error.validation
    ) {
      const violations = Array.isArray(error.validation)
        ? error.validation.map((violation) => ({
            code: "REQUEST_VALIDATION_FAILED",
            message: violation.message ?? "Request validation failed",
            ...(violation.instancePath ? { field: violation.instancePath } : {}),
          }))
        : []
      return reply.code(400).send({
        code: "REQUEST_VALIDATION_FAILED",
        message: "Request validation failed",
        violations,
      })
    }
    if (isPlatformApiError(error)) {
      const violations = error.violations.length > 0
        ? error.violations
        : error.statusCode === 422
          ? [{ code: error.code, message: error.message }]
          : []
      return reply.code(error.statusCode).send({
        code: error.code,
        message: error.message,
        violations,
      })
    }
    app.log.error(error)
    return reply.code(500).send({ code: "INTERNAL_ERROR" })
  })

  app.addHook("onError", async (request, _reply, error) => {
    if (request.ws) {
      request.log.error({ err: error }, "Runtime WebSocket upgrade failed")
    }
  })

  app.addHook("onRequest", authorization.authenticate)

  app.addHook("preValidation", authorization.normalize)

  app.addHook("preHandler", authorization.authorize)

  await app.register(resourceHttp, {
    catalog: dependencies.resourceCatalog,
    registry: resourceRegistry,
  })
  await app.register(demoProjectHttp, { service: demoProject })
  await app.register(organizationHttp, {
    directory: dependencies.modules.organizations,
  })
  await app.register(identityHttp, {
    directory: dependencies.modules.identity,
    sessionControl: dependencies.subjectSessionControl,
    organizations: dependencies.modules.organizations,
    policy: dependencies.modules.botAccessPolicy,
    connections: dependencies.modules.connections,
  })
  await app.register(accessGroupHttp, {
    directory: dependencies.modules.accessGroups,
  })
  if (dependencies.identityProviders) {
    await app.register(identityProviderHttp, { registry: dependencies.identityProviders })
  }
  await app.register(applicationHttp, { registry: dependencies.modules.applications })
  await app.register(federationHttp, {
    service: dependencies.modules.federation,
    applications: dependencies.modules.applications,
  })
  await app.register(connectionHttp, {
    connectorDeployment: dependencies.connectorDeployment,
    registry: dependencies.modules.connections,
    authorizeRuntime: authorizeGatewayRuntime,
    async runtimeGatewayId({ tenantId, runtimeId }) {
      const registration = await dependencies.modules.runtimeControl.getGatewayRuntime({
        tenantId,
        runtimeKind: "GATEWAY",
        runtimeId,
      })
      if (!registration || registration.status !== "ACTIVE") {
        throw new PlatformApiError("RUNTIME_RUNTIME_NOT_ACTIVE", 403)
      }
      return registration.target_id
    },
  })
  await app.register(mcpDiscoveryHttp, {
    store: dependencies.modules.mcpDiscovery,
    registrations: dependencies.modules.runtimeControl,
    authorizeRuntime: authorizeGatewayRuntime,
    oauth: dependencies.modules.mcpOAuth,
  })
  await app.register(mcpOAuthHttp, {
    passwords: dependencies.modules.personalCredentials,
    service: dependencies.modules.mcpOAuth,
    registrations: dependencies.modules.runtimeControl,
    authorizeRuntime: authorizeGatewayRuntime,
  })
  await app.register(personalConnectionHttp, {
    passwords: dependencies.modules.personalCredentials,
    access: dependencies.modules.access,
    connections: dependencies.modules.connections,
    oauth: dependencies.modules.mcpOAuth,
  })
  await app.register(providerHttp, {
    catalog: dependencies.modules.providers,
  })
  await app.register(providerCredentialProfileHttp, {
    store: dependencies.modules.providerCredentials,
  })
  await app.register(modelHttp, {
    catalog: dependencies.modules.models,
    entitlementResolver: dependencies.entitlementResolver ?? dependencies.modules.entitlements,
  })
  await app.register(modelRoutingHttp, {
    router: dependencies.modules.modelRouter,
    policies: dependencies.modules.modelRoutingPolicies,
    resources: dependencies.modules.resources,
  })
  await app.register(modelEntitlementHttp, {
    catalog: dependencies.modules.entitlements,
  })
  await app.register(agentDelegationHttp, {
    directory: dependencies.modules.agentDelegations,
  })
  await app.register(executionGrantHttp, {
    directory: dependencies.modules.executionGrants,
  })
  await app.register(permissionPreviewHttp, {
    policy: dependencies.modules.botAccessPolicy,
    accessGroups: dependencies.modules.accessGroups,
    identity: dependencies.modules.identity,
    organizations: dependencies.modules.organizations,
    access: dependencies.modules.access,
    audit: dependencies.modules.auditEvents,
  })
  await app.register(onePolicyHttp, {
    policy: dependencies.modules.botAccessPolicy,
    drafts: dependencies.modules.policyDrafts,
  })
  await app.register(enforcementHttp, {
    drafts: dependencies.modules.policyDrafts,
    compiler: dependencies.modules.enforcementCompiler,
    revisionStore: dependencies.modules.enforcementRevisionStore,
    resources: dependencies.modules.resources,
  })
  await app.register(publicationWorkflowHttp, {
    workflow: dependencies.modules.publicationWorkflow,
  })
  await app.register(gatewayProjectionHttp, {
    projector: dependencies.modules.gatewayProjector,
  })
  await app.register(gatewayActivityHttp, {
    store: dependencies.modules.activities,
    detail: dependencies.modules.activityDetails,
    materializer: dependencies.modules.activityMaterializer,
    metrics: dependencies.modules.metrics,
    authorizeRuntime: authorizeGatewayRuntime,
  })
  await app.register(usageGovernanceHttp, {
    directory: dependencies.modules.usageGovernance,
    accountingLedger: dependencies.modules.accountingLedger,
    usageCounterStore: dependencies.modules.usageCounterStore,
    authorizeRuntime: authorizeGatewayRuntime,
  })
  await app.register(endpointActivityHttp, {
    store: dependencies.modules.endpointActivities,
    runtime: dependencies.modules.endpointRuntime,
    authorizeEndpoint,
  })
  await app.register(endpointRuntimeWebSocket, { store: dependencies.modules.endpointRuntime, authorizeEndpoint })
  await app.register(endpointRuntimeHttp, {
    store: dependencies.modules.endpointRuntime,
    authorizeEndpoint,
  })
  await app.register(traceHttp, { store: dependencies.modules.traces })
  registerBrowserTelemetry(app, { path: "/v1/tenants/:tenant_id/browser-telemetry", service: "genio-one-platform-web", principal: async request => {
    if (!request.principal) throw new Error("AUTHENTICATION_REQUIRED")
    if (request.principal.tenant_id !== (request.params as { tenant_id: string }).tenant_id) throw new Error("TENANT_MISMATCH")
    return request.principal
  } })
  await app.register(gatewayMetricsHttp, { store: dependencies.modules.metrics })
  await app.register(gatewayAuthorizationAuditHttp, {
    store: dependencies.modules.auditEvents,
    authorizeRuntime: authorizeGatewayRuntime,
  })
  await app.register(siemHttp, { forwarder: dependencies.modules.siem })
  await app.register(notificationHttp, { store: dependencies.modules.notifications })
  await app.register(configurationHttp, { store: dependencies.modules.configuration })
  await app.register(gatewayDiagnosticSettingsHttp, {
    store: dependencies.modules.gatewayDiagnosticSettings,
  })
  await app.register(gatewayRegistrationHttp, {
    lifecycle: dependencies.modules.gatewayRegistrations,
  })
  await app.register(discoveryMcpHttp, { access: dependencies.modules.access, connections: dependencies.modules.connections })
  await app.register(accessHttp, { store: dependencies.modules.access })
  await app.register(runtimeControlHttp, {
    store: dependencies.modules.runtimeControl,
  })
  if (dependencies.modules.gatewayAggregateRuntimeControl) {
    await app.register(gatewayAggregateRuntimeControlHttp, {
      store: dependencies.modules.gatewayAggregateRuntimeControl.store,
      registrations: dependencies.modules.runtimeControl,
      packages: dependencies.modules.gatewayAggregateRuntimeControl.packages,
      credentials: dependencies.modules.providerCredentials,
      authorizeRuntime: authorizeGatewayRuntime,
    })
  }
  await app.register(runtimeInventoryHttp, {
    runtimeControl: dependencies.modules.runtimeControl,
    gatewayRegistrations: dependencies.modules.gatewayRegistrations,
    ...(dependencies.modules.gatewayAggregateRuntimeControl
      ? { aggregate: dependencies.modules.gatewayAggregateRuntimeControl.store }
      : {}),
  })
  return app
}
