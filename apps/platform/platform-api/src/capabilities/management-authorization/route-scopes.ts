import { GENIOONE_SCOPES, MANAGEMENT_SCOPES, RESOURCE_SCOPE_VALUES } from "@genioone/protocol/authorization-scopes"

interface TenantScopeRoute {
  rest: string[]
}

const managementRouteScopes: Readonly<Record<string, readonly [string, string]>> = {
  identity: [MANAGEMENT_SCOPES.identityRead, MANAGEMENT_SCOPES.identityWrite],
  "identity-providers": [MANAGEMENT_SCOPES.identityRead, MANAGEMENT_SCOPES.identityWrite],
  organizations: [MANAGEMENT_SCOPES.identityRead, MANAGEMENT_SCOPES.identityWrite],
  applications: [MANAGEMENT_SCOPES.identityRead, MANAGEMENT_SCOPES.identityWrite],
  resources: [MANAGEMENT_SCOPES.resourcesRead, MANAGEMENT_SCOPES.resourcesWrite],
  providers: [MANAGEMENT_SCOPES.resourcesRead, MANAGEMENT_SCOPES.resourcesWrite],
  connectors: [MANAGEMENT_SCOPES.resourcesRead, MANAGEMENT_SCOPES.resourcesWrite],
  models: [MANAGEMENT_SCOPES.resourcesRead, MANAGEMENT_SCOPES.resourcesWrite],
  "demo-project": [MANAGEMENT_SCOPES.resourcesRead, MANAGEMENT_SCOPES.resourcesWrite],
  "team-workspaces": [MANAGEMENT_SCOPES.resourcesRead, MANAGEMENT_SCOPES.resourcesWrite],
  "knowledge-candidates": [MANAGEMENT_SCOPES.resourcesRead, MANAGEMENT_SCOPES.resourcesWrite],
  "one-policy": [MANAGEMENT_SCOPES.policiesRead, MANAGEMENT_SCOPES.policiesWrite],
  "enforcement-chains": [MANAGEMENT_SCOPES.policiesRead, MANAGEMENT_SCOPES.policiesWrite],
  "processor-adapters": [MANAGEMENT_SCOPES.policiesRead, MANAGEMENT_SCOPES.policiesWrite],
  "usage-policies": [MANAGEMENT_SCOPES.policiesRead, MANAGEMENT_SCOPES.policiesWrite],
  "access-groups": [MANAGEMENT_SCOPES.accessRead, MANAGEMENT_SCOPES.accessWrite],
  "access-requests": [MANAGEMENT_SCOPES.accessRead, MANAGEMENT_SCOPES.accessWrite],
  entitlements: [MANAGEMENT_SCOPES.accessRead, MANAGEMENT_SCOPES.accessWrite],
  "agent-delegations": [MANAGEMENT_SCOPES.accessRead, MANAGEMENT_SCOPES.accessWrite],
  "execution-grant-requests": [MANAGEMENT_SCOPES.accessRead, MANAGEMENT_SCOPES.accessWrite],
  "provider-credential-profiles": [MANAGEMENT_SCOPES.credentialsRead, MANAGEMENT_SCOPES.credentialsWrite],
  "runtime-control": [MANAGEMENT_SCOPES.runtimeRead, MANAGEMENT_SCOPES.runtimeWrite],
  runtimes: [MANAGEMENT_SCOPES.runtimeRead, MANAGEMENT_SCOPES.runtimeWrite],
  endpoints: [MANAGEMENT_SCOPES.runtimeRead, MANAGEMENT_SCOPES.runtimeWrite],
  gateways: [MANAGEMENT_SCOPES.runtimeRead, MANAGEMENT_SCOPES.runtimeWrite],
  "gateway-sites": [MANAGEMENT_SCOPES.runtimeRead, MANAGEMENT_SCOPES.runtimeWrite],
  "gateway-groups": [MANAGEMENT_SCOPES.runtimeRead, MANAGEMENT_SCOPES.runtimeWrite],
  "gateway-rollbacks": [MANAGEMENT_SCOPES.runtimeRead, MANAGEMENT_SCOPES.runtimeWrite],
  "audit-events": [MANAGEMENT_SCOPES.auditRead, MANAGEMENT_SCOPES.auditRead],
  activities: [MANAGEMENT_SCOPES.auditRead, MANAGEMENT_SCOPES.auditRead],
  "activity-sessions": [MANAGEMENT_SCOPES.auditRead, MANAGEMENT_SCOPES.auditRead],
  "ai-activities": [MANAGEMENT_SCOPES.auditRead, MANAGEMENT_SCOPES.auditRead],
  "api-activities": [MANAGEMENT_SCOPES.auditRead, MANAGEMENT_SCOPES.auditRead],
  "ai-usage": [MANAGEMENT_SCOPES.auditRead, MANAGEMENT_SCOPES.auditRead],
  "transaction-trends": [MANAGEMENT_SCOPES.auditRead, MANAGEMENT_SCOPES.auditRead],
  "configuration-revisions": [MANAGEMENT_SCOPES.systemRead, MANAGEMENT_SCOPES.systemWrite],
  "siem-destination": [MANAGEMENT_SCOPES.systemRead, MANAGEMENT_SCOPES.systemWrite],
  "siem-deliveries": [MANAGEMENT_SCOPES.systemRead, MANAGEMENT_SCOPES.systemWrite],
  telemetry: [MANAGEMENT_SCOPES.systemRead, MANAGEMENT_SCOPES.systemWrite],
  metrics: [MANAGEMENT_SCOPES.systemRead, MANAGEMENT_SCOPES.systemWrite],
  traces: [MANAGEMENT_SCOPES.systemRead, MANAGEMENT_SCOPES.systemWrite],
  logs: [MANAGEMENT_SCOPES.systemRead, MANAGEMENT_SCOPES.systemWrite],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isSharedMemoryRoute(route: TenantScopeRoute, area: string): boolean {
  if (route.rest[0] !== area || !route.rest[1] || route.rest[2] !== "memories") return false
  if (route.rest.length === 3 || route.rest.length === 4) return true
  if (route.rest.length === 5 && route.rest[4] === "corrections") return true
  return route.rest.length === 7 && route.rest[4] === "corrections" && route.rest[6] === "review"
}

function isMemoryRoute(route: TenantScopeRoute, method: string): boolean {
  if (isSharedMemoryRoute(route, "organizations") || isSharedMemoryRoute(route, "team-workspaces")) return true
  if (route.rest[0] !== "me") return false
  if (["memories", "memory-agents"].includes(route.rest[1] ?? "")) return route.rest.length === 2 || route.rest.length === 3
  return method === "GET" && route.rest.length === 2 && route.rest[1] === "memory-scopes"
}

function isSelfServiceRoute(route: TenantScopeRoute, method: string): boolean {
  const [area, operation] = route.rest
  if (method === "GET" || method === "HEAD") {
    if (route.rest.length === 0) return true
    if (["self-service-configuration", "catalog", "me", "distillation-markers"].includes(area ?? "")) return true
    if (area === "team-workspaces" && (route.rest.length === 1 || route.rest.length === 2)) return true
    if (area === "knowledge-candidates") return !["review-context", "evidence"].includes(route.rest[2] ?? "")
    if (area === "one-policy" && ["bot-access", "runtime-effective"].includes(operation ?? "")) return true
    if (area === "telemetry" && route.rest.length === 3 && operation === "posthog" && route.rest[2] === "browser-configuration") return true
  }
  if (area === "me" && operation === "resource-connections") {
    return (method === "POST" && route.rest.length === 5 && ["authorize", "password", "discovery"].includes(route.rest[4]!)) ||
      (method === "DELETE" && route.rest.length === 4)
  }
  if (method !== "POST") return false
  if (area === "me" && operation === "agents" && route.rest.length === 2) return true
  if (area === "me" && operation === "entitlements" && route.rest.length === 3 && route.rest[2] === "activate") return true
  if (area === "resource-onboarding-requests") return true
  return area === "access-requests" &&
    (route.rest.length === 1 || (route.rest.length === 3 && route.rest[2] === "cancel"))
}

export function requiredPlatformRouteScopes(route: TenantScopeRoute, method: string, body?: unknown): readonly string[] {
  const [area, operation] = route.rest
  const read = method === "GET" || method === "HEAD"
  const last = route.rest.at(-1)
  if (area === "memory" && operation === "mcp" && route.rest.length === 2) {
    const tool = isRecord(body) && body.method === "tools/call" && isRecord(body.params) ? body.params.name : undefined
    return [tool === "memory_remember" || tool === "memory_forget" ? GENIOONE_SCOPES.write : GENIOONE_SCOPES.read]
  }
  if (isMemoryRoute(route, method)) return [read ? GENIOONE_SCOPES.read : GENIOONE_SCOPES.write]
  if ((method === "POST" && area === "model-routing" && operation === "resolve" && route.rest.length === 2) ||
    (method === "POST" && area === "invocations" && operation === "authorize") ||
    (method === "POST" && area === "one-policy" && ["runtime-authorize", "runtime-report"].includes(operation ?? ""))) return [GENIOONE_SCOPES.invoke]
  if (area === "discovery" && operation === "mcp" && route.rest.length === 2) return RESOURCE_SCOPE_VALUES
  if (area === "distillation-markers" && method === "DELETE" && operation === "bots" && route.rest.length === 3) return [GENIOONE_SCOPES.write, MANAGEMENT_SCOPES.resourcesWrite]
  if (area === "distillation-markers" && method === "POST") return [GENIOONE_SCOPES.write]
  if (area === "endpoints" && method === "POST" && operation === "bootstrap" && route.rest.length === 2) return [GENIOONE_SCOPES.write, MANAGEMENT_SCOPES.runtimeWrite]
  if (area === "organizations" && read && route.rest.length === 3 && route.rest[2] === "use-cases") return [GENIOONE_SCOPES.read, MANAGEMENT_SCOPES.identityRead]
  if (area === "notification-subscriptions" || area === "browser-telemetry") return [read ? GENIOONE_SCOPES.read : GENIOONE_SCOPES.write]
  if (isSelfServiceRoute(route, method) && !(area === "me" && ["memories", "memory-agents", "memory-scopes"].includes(operation ?? ""))) return [read ? GENIOONE_SCOPES.read : GENIOONE_SCOPES.write]
  if (method === "POST" && area === "usage-policies" && route.rest.length === 1) return [MANAGEMENT_SCOPES.policiesPublish]
  if (area === "audit-export" && read && route.rest.length === 1) return [MANAGEMENT_SCOPES.auditExport]
  if (area === "applications" && ["api-credentials", "federation-trust-revisions", "federation-exchanges"].includes(route.rest[2] ?? "")) return [read ? MANAGEMENT_SCOPES.credentialsRead : MANAGEMENT_SCOPES.credentialsWrite]
  if (method === "POST" && (
    ((area === "access-requests" || area === "execution-grant-requests") && route.rest[2] === "decision") ||
    (area === "entitlements" && route.rest.length === 1) ||
    (area === "agent-delegations" && route.rest.length === 1) ||
    (area === "knowledge-candidates" && route.rest[2] === "review") ||
    (area === "resources" && route.rest.includes("mcp-discovery") && ["decision", "read-only-approval"].includes(last ?? ""))
  )) return [MANAGEMENT_SCOPES.accessApprove]
  const resourcePolicy = area === "resources" && route.rest[2] === "capabilities" && ["policy-draft", "enforcement-chain", "model-routing-policy"].includes(route.rest[4] ?? "")
  const policyOperation = area === "one-policy" || resourcePolicy
  if ((area === "resources" && route.rest.length === 5 && route.rest[2] === "publication-requests" && last === "review") ||
    (method === "POST" && area === "resources" && route.rest[2] === "lifecycle" && isRecord(body) && body.lifecycle === "PUBLISHED") ||
    (policyOperation && (
      (method === "POST" && ["review", "publish"].includes(last ?? "")) ||
      (method === "PATCH" && area === "one-policy" && (route.rest.length === 2 || (operation === "runtime-policies" && route.rest.length === 3))) ||
      (method === "PUT" && resourcePolicy && route.rest[4] === "model-routing-policy")
    )) ||
    (method === "POST" && area === "configuration-revisions" && ["review", "publish", "retry", "rollback"].includes(last ?? ""))) return [MANAGEMENT_SCOPES.policiesPublish]
  if (resourcePolicy) return [read ? MANAGEMENT_SCOPES.policiesRead : MANAGEMENT_SCOPES.policiesWrite]
  if (method === "POST" && ((area === "ai-gateway" && last === "preview") || (area === "one-policy" && operation === "permission-preview"))) return [MANAGEMENT_SCOPES.policiesRead]
  if (area === "ai-gateway") return [read ? MANAGEMENT_SCOPES.runtimeRead : MANAGEMENT_SCOPES.runtimeWrite]
  if (method === "POST" && area === "activities" && route.rest[2] === "outcomes") return [MANAGEMENT_SCOPES.runtimeWrite]
  const scopes = managementRouteScopes[area ?? ""]
  return scopes ? [scopes[read ? 0 : 1]] : []
}

export function platformRouteScopeRequirements(route: TenantScopeRoute, method: string, body: unknown): readonly (readonly string[])[] {
  const messages = route.rest.length === 2 && route.rest[0] === "memory" && route.rest[1] === "mcp" && Array.isArray(body) ? body : [body]
  return messages.length ? messages.map(message => requiredPlatformRouteScopes(route, method, message)) : [[]]
}
