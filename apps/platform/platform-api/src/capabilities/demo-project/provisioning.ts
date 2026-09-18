import type { ResourceConnectionRegistry } from "../connections/module"
import type { ModelEntitlementCatalog } from "../entitlements/module"
import type { EnforcementChainCompiler, EnforcementChainRevisionReader } from "../enforcement/module"
import { PlatformApiError } from "../errors"
import type { GatewayRegistrationLifecycle } from "../gateway-registration/module"
import type { McpDiscoveryStore } from "../mcp-discovery/module"
import type { AiResourcePublicationWorkflow } from "../publications/module"
import type { ResourceRegistration } from "../resources/contract"
import type { ResourceRegistry } from "../resources/module"
import type { RuntimeControlStore } from "../runtime-control/contract"
import { mcpToolCapabilityId } from "../../../../../../runtimes/gateway/services/shared/mcp-tool-capability"

export type DemoMcpProvisioningStage =
  | "READY"
  | "DISCOVERY_PENDING"
  | "CONNECTION_VERIFICATION_FAILED"
  | "CONNECTION_DISABLED"
  | "GATEWAY_PREREQUISITE"
  | "POLICY_PREREQUISITE"
  | "PUBLICATION_PREREQUISITE"
  | "TOOLS_UNAVAILABLE"
  | "TOOLS_BLOCKED"
  | "TOOLS_IGNORED"
  | "PUBLICATION_REJECTED"
  | "PUBLICATION_PENDING_REVIEW"

export interface DemoMcpProvisioningResult {
  stage: DemoMcpProvisioningStage
  detail: string
  resourceId: string
  connectionId: string
  gatewayId?: string
  discoveryOperationId?: string
}

export interface DemoMcpGatewayIdentity {
  issuer: string
  audience: string
  jwksUri: string
}

export interface DemoMcpPublicationTarget {
  gatewayId: string
  origin: string
  basePath?: string
  dnsManagement: "PLATFORM_MANAGED" | "EXTERNAL"
  dnsTarget?: string | null
}

export interface DemoMcpProvisioningModules {
  resources: ResourceRegistry
  connections: ResourceConnectionRegistry
  mcpDiscovery: McpDiscoveryStore
  enforcementCompiler: EnforcementChainCompiler
  enforcementRevisions: EnforcementChainRevisionReader
  publicationWorkflow: AiResourcePublicationWorkflow
  entitlements: ModelEntitlementCatalog
  gatewayRegistrations: Pick<GatewayRegistrationLifecycle, "list">
  runtimeControl: Pick<RuntimeControlStore, "listGatewayRuntimes">
}

export interface PrepareDemoMcpInput {
  tenantId: string
  organizationId: string
  actorSubjectId: string
  resourceId: string
  connectionId: string
  requiredToolNames: readonly string[]
  modules: DemoMcpProvisioningModules
  gatewayIdentity: DemoMcpGatewayIdentity
  publicationTarget?: DemoMcpPublicationTarget
  initialOnePolicyRevision?: number
  correlationId?: string
}

interface GatewayPublicationDomain {
  gatewayId: string
  hostname: string
  basePath: string
  dnsManagement: "PLATFORM_MANAGED" | "EXTERNAL"
  dnsTarget: string | null | undefined
}

function normalizedBasePath(value: string | undefined): string | null {
  const path = (value ?? "/").trim()
  if (!path.startsWith("/") || /[?#\s]/.test(path)) return null
  return path === "/" ? path : path.replace(/\/+$/, "") || "/"
}

function result(
  input: PrepareDemoMcpInput,
  stage: DemoMcpProvisioningStage,
  detail: string,
  extras: Pick<DemoMcpProvisioningResult, "gatewayId" | "discoveryOperationId"> = {},
): DemoMcpProvisioningResult {
  return {
    stage,
    detail,
    resourceId: input.resourceId,
    connectionId: input.connectionId,
    ...extras,
  }
}

function requiredTools(input: PrepareDemoMcpInput): string[] {
  return [...new Set(input.requiredToolNames.map((tool) => tool.trim()).filter(Boolean))].sort()
}

function isLegacyDemoBasePath(input: PrepareDemoMcpInput, path: string): boolean {
  return path === `/mcp/${input.resourceId}`
}

function domainForResource(resource: ResourceRegistration): GatewayPublicationDomain | null {
  const endpoint = resource.publication_endpoint
  if (
    resource.lifecycle !== "PUBLISHED" ||
    !endpoint ||
    endpoint.dns_verification !== "VERIFIED"
  ) return null
  return {
    gatewayId: endpoint.gateway_id,
    hostname: endpoint.hostname,
    basePath: endpoint.base_path,
    dnsManagement: endpoint.dns_management,
    dnsTarget: endpoint.dns_target,
  }
}

async function selectGatewayDomain(input: PrepareDemoMcpInput): Promise<GatewayPublicationDomain | null> {
  const [resources, registrations, runtimes] = await Promise.all([
    input.modules.resources.listResources({ tenantId: input.tenantId }),
    input.modules.gatewayRegistrations.list({ tenantId: input.tenantId }),
    input.modules.runtimeControl.listGatewayRuntimes({ tenantId: input.tenantId }),
  ])
  const activeGateways = new Set(runtimes.filter((runtime) => runtime.status === "ACTIVE").map((runtime) => runtime.target_id))
  const registeredGateways = new Set(registrations.filter((registration) => registration.state === "ACTIVE").map((registration) => registration.gateway_id))
  const target = input.publicationTarget
  if (target) {
    let origin: URL
    try {
      origin = new URL(target.origin)
    } catch {
      return null
    }
    const basePath = normalizedBasePath(target.basePath)
    if (
      !["http:", "https:"].includes(origin.protocol) ||
      !origin.hostname ||
      origin.username ||
      origin.password ||
      !basePath ||
      !activeGateways.has(target.gatewayId) ||
      !registeredGateways.has(target.gatewayId)
    ) return null
    return {
      gatewayId: target.gatewayId,
      hostname: origin.hostname,
      basePath,
      dnsManagement: target.dnsManagement,
      dnsTarget: target.dnsTarget,
    }
  }
  return resources
    .map(domainForResource)
    .filter((domain): domain is GatewayPublicationDomain => Boolean(domain))
    .filter((domain) => activeGateways.has(domain.gatewayId) && registeredGateways.has(domain.gatewayId))
    .sort((left, right) =>
      left.gatewayId.localeCompare(right.gatewayId) || left.hostname.localeCompare(right.hostname),
    )[0] ?? null
}

function defaultSteps(identity: DemoMcpGatewayIdentity) {
  return [
    {
      step_id: "authenticate",
      kind: "AUTHENTICATE" as const,
      phase: "REQUEST" as const,
      implementation: "NATIVE" as const,
      depends_on: [],
      config: {
        schema_version: "genio.one.auth.jwt.v1" as const,
        provider: "genio-one",
        issuer: identity.issuer,
        audiences: [identity.audience],
        remote_jwks_uri: identity.jwksUri,
        subject_claim: "sub",
        client_claim: "azp",
      },
    },
    {
      step_id: "authorize",
      kind: "AUTHORIZE" as const,
      phase: "REQUEST" as const,
      implementation: "EXT_AUTH" as const,
      depends_on: ["authenticate"],
      config: {},
    },
    {
      step_id: "route",
      kind: "ROUTE" as const,
      phase: "ROUTING" as const,
      implementation: "AIGW_NATIVE" as const,
      depends_on: ["authorize"],
      config: {},
    },
  ]
}

async function ensureActorEntitlements(
  input: PrepareDemoMcpInput,
  capabilityIds: readonly string[],
): Promise<void> {
  const existing = await input.modules.entitlements.list({ tenantId: input.tenantId })
  for (const capabilityId of capabilityIds) {
    if (existing.some((entitlement) =>
      entitlement.state === "ACTIVE" &&
      entitlement.subject_id === input.actorSubjectId &&
      entitlement.resource_id === input.resourceId &&
      entitlement.capability_id === capabilityId,
    )) continue
    await input.modules.entitlements.grant({
      tenantId: input.tenantId,
      value: {
        subject_id: input.actorSubjectId,
        resource_id: input.resourceId,
        capability_id: capabilityId,
      },
    })
  }
}

async function ensureChain(
  input: PrepareDemoMcpInput,
  resource: ResourceRegistration,
  onePolicyRevision: number,
): Promise<void> {
  const capability = resource.capabilities.find((candidate) => !candidate.capability_id.startsWith("mcp-tool-"))
  if (!capability) return
  const existing = await input.modules.enforcementRevisions.getLatest({
    tenantId: input.tenantId,
    resourceId: input.resourceId,
    capabilityId: capability.capability_id,
  })
  if (existing) return
  const compiled = await input.modules.enforcementCompiler.compile({
    tenantId: input.tenantId,
    value: {
      resource_id: input.resourceId,
      capability_id: capability.capability_id,
      eligible_connection_ids: [input.connectionId],
      one_policy_revision: onePolicyRevision,
      steps: defaultSteps(input.gatewayIdentity),
    },
  })
  await input.modules.enforcementRevisions.save({ tenantId: input.tenantId, chain: compiled })
}

export async function prepareDemoMcp(input: PrepareDemoMcpInput): Promise<DemoMcpProvisioningResult> {
  const tools = requiredTools(input)
  if (tools.length === 0) return result(input, "TOOLS_UNAVAILABLE", "示範 MCP 未指定需選取的工具。")
  const [resource, connection, domain] = await Promise.all([
    input.modules.resources.getResource({ tenantId: input.tenantId, resourceId: input.resourceId }),
    input.modules.connections.get({ tenantId: input.tenantId, resourceId: input.resourceId, connectionId: input.connectionId }),
    selectGatewayDomain(input),
  ])
  if (!domain) {
    return result(input, "GATEWAY_PREREQUISITE", "請先完成已啟用的 Gateway Runtime、Gateway registration 與可驗證的發佈 origin，再重送示範設定。")
  }
  if (resource.enforcement_point_id !== domain.gatewayId) {
    return result(input, "GATEWAY_PREREQUISITE", "示範 Resource 綁定的 Gateway 與可用發佈網域不同；請以同一 Gateway 建立示範 Resource。", { gatewayId: domain.gatewayId })
  }
  const baselineCapability = resource.capabilities.find((candidate) => !candidate.capability_id.startsWith("mcp-tool-"))
  const existingChain = baselineCapability
    ? await input.modules.enforcementRevisions.getLatest({
        tenantId: input.tenantId,
        resourceId: input.resourceId,
        capabilityId: baselineCapability.capability_id,
      })
    : null
  const onePolicyRevision = existingChain?.one_policy_revision ?? input.initialOnePolicyRevision
  if (typeof onePolicyRevision !== "number" || !Number.isSafeInteger(onePolicyRevision) || onePolicyRevision < 1) {
    return result(input, "POLICY_PREREQUISITE", "示範 Resource 尚未有正式 One Policy revision；請先建立並發佈基準 policy 後重送。", { gatewayId: domain.gatewayId })
  }
  if (connection.lifecycle === "DISABLED" || connection.lifecycle === "REVOKE_PENDING" || connection.lifecycle === "REVOKED") {
    return result(input, "CONNECTION_DISABLED", "示範連線已被停用或撤銷；請由管理者明確重新啟用後再重送示範設定。", { gatewayId: domain.gatewayId })
  }
  let verified = connection
  if (verified.verification_state !== "VERIFIED") {
    try {
      verified = await input.modules.connections.verify({
        tenantId: input.tenantId,
        resourceId: input.resourceId,
        connectionId: input.connectionId,
      })
    } catch {
      return result(input, "CONNECTION_VERIFICATION_FAILED", "示範連線尚未通過驗證；請檢查服務、credential 與網路後重送。", { gatewayId: domain.gatewayId })
    }
  }
  let discovery = await input.modules.mcpDiscovery.latest({
    tenantId: input.tenantId,
    resourceId: input.resourceId,
    connectionId: input.connectionId,
  })
  if (!discovery || discovery.state === "FAILED") {
    discovery = await input.modules.mcpDiscovery.request({
      tenantId: input.tenantId,
      resourceId: input.resourceId,
      connectionId: input.connectionId,
      requestedBySubjectId: input.actorSubjectId,
      correlationId: input.correlationId ?? `ce-demo:${input.resourceId}:${input.connectionId}`,
    })
  }
  if (discovery.state !== "SUCCEEDED") {
    return result(input, "DISCOVERY_PENDING", "Gateway Runtime 正在查詢上游 MCP 的實際工具；完成後請重送示範設定。", {
      gatewayId: domain.gatewayId,
      discoveryOperationId: discovery.operation_id,
    })
  }
  const candidates = new Map(discovery.candidates.map((candidate) => [candidate.tool_name, candidate]))
  const missing = tools.filter((tool) => !candidates.has(tool))
  if (missing.length > 0) {
    return result(input, "TOOLS_UNAVAILABLE", `上游 MCP 沒有回報必要工具：${missing.join("、")}。`, { gatewayId: domain.gatewayId, discoveryOperationId: discovery.operation_id })
  }
  const blocked = tools.filter((tool) => candidates.get(tool)!.state === "BLOCKED")
  if (blocked.length > 0) {
    return result(input, "TOOLS_BLOCKED", `必要工具已被使用者封鎖：${blocked.join("、")}。`, { gatewayId: domain.gatewayId, discoveryOperationId: discovery.operation_id })
  }
  const ignored = tools.filter((tool) => candidates.get(tool)!.state === "IGNORED")
  if (ignored.length > 0) {
    return result(input, "TOOLS_IGNORED", `必要工具已被使用者略過：${ignored.join("、")}。`, { gatewayId: domain.gatewayId, discoveryOperationId: discovery.operation_id })
  }
  for (const tool of tools) {
    const candidate = candidates.get(tool)!
    if (candidate.state === "PUBLISHED") continue
    await input.modules.mcpDiscovery.decideCandidate({
      tenantId: input.tenantId,
      resourceId: input.resourceId,
      connectionId: input.connectionId,
      candidateId: candidate.candidate_id,
      expectedRevisionDigest: candidate.revision_digest,
      state: "PUBLISHED",
    })
  }
  verified = await input.modules.connections.get({
    tenantId: input.tenantId,
    resourceId: input.resourceId,
    connectionId: input.connectionId,
  })
  if (verified.lifecycle === "DRAFT") {
    verified = await input.modules.connections.transitionLifecycle({
      tenantId: input.tenantId,
      resourceId: input.resourceId,
      connectionId: input.connectionId,
      value: {
        correlation_id: input.correlationId ?? `ce-demo:${input.resourceId}:${input.connectionId}`,
        expected_revision: verified.configuration_revision,
        command: "ENABLE",
      },
    })
  }
  if (verified.lifecycle !== "ENABLED") {
    return result(input, "CONNECTION_DISABLED", "示範連線未處於啟用狀態；請由管理者檢查連線生命週期。", { gatewayId: domain.gatewayId, discoveryOperationId: discovery.operation_id })
  }
  let current = await input.modules.resources.getResource({ tenantId: input.tenantId, resourceId: input.resourceId })
  const expectedPath = domain.basePath
  const canReplaceLegacyEndpoint = current.lifecycle === "DRAFT" &&
    current.publication_endpoint?.gateway_id === domain.gatewayId &&
    current.publication_endpoint.hostname === domain.hostname &&
    isLegacyDemoBasePath(input, current.publication_endpoint.base_path)
  if (current.lifecycle === "DRAFT" && (!current.publication_endpoint || canReplaceLegacyEndpoint)) {
    current = await input.modules.resources.setPublicationEndpoint({
      tenantId: input.tenantId,
      resourceId: input.resourceId,
      value: {
        gateway_id: domain.gatewayId,
        hostname: domain.hostname,
        base_path: expectedPath,
        visibility: "REQUEST",
        dns_management: domain.dnsManagement,
        dns_verification: "VERIFIED",
        dns_target: domain.dnsTarget,
      },
    })
  }
  if (current.lifecycle === "DRAFT" && !current.publication_endpoint) {
    return result(input, "PUBLICATION_PREREQUISITE", "示範 Resource 尚未有可用發佈端點；請完成 Gateway 網域設定後重送。", { gatewayId: domain.gatewayId, discoveryOperationId: discovery.operation_id })
  }
  if (current.lifecycle === "DRAFT") {
    const endpoint = current.publication_endpoint!
    if (endpoint.gateway_id !== domain.gatewayId || endpoint.hostname !== domain.hostname || endpoint.base_path !== expectedPath) {
      return result(input, "PUBLICATION_PREREQUISITE", "示範 Resource 已有不同的發佈端點；為避免覆寫既有設定，請使用該端點完成發佈。", { gatewayId: domain.gatewayId, discoveryOperationId: discovery.operation_id })
    }
    await ensureChain(input, current, onePolicyRevision)
    const request = current.publication_request
    if (request?.state === "REJECTED") {
      return result(input, "PUBLICATION_REJECTED", "示範發佈曾被拒絕；請由審核者建立新的發佈流程。", { gatewayId: domain.gatewayId, discoveryOperationId: discovery.operation_id })
    }
    const review = await input.modules.publicationWorkflow.requestReview({
      tenantId: input.tenantId,
      resourceId: input.resourceId,
      requestedBy: input.actorSubjectId,
    })
    try {
      current = await input.modules.publicationWorkflow.review({
        tenantId: input.tenantId,
        resourceId: input.resourceId,
        requestId: review.request_id,
        reviewerId: input.actorSubjectId,
        decision: "APPROVE",
      })
    } catch (error) {
      if (error instanceof PlatformApiError && error.code === "PUBLICATION_BUILD_IN_PROGRESS") {
        return result(input, "PUBLICATION_PENDING_REVIEW", "示範發佈正在進行簽章與套用；完成後請重送示範設定。", { gatewayId: domain.gatewayId, discoveryOperationId: discovery.operation_id })
      }
      throw error
    }
  }
  if (current.lifecycle !== "PUBLISHED") {
    return result(input, "PUBLICATION_PENDING_REVIEW", "示範發佈尚未完成；請等待 Gateway 簽章與套用後重送。", { gatewayId: domain.gatewayId, discoveryOperationId: discovery.operation_id })
  }
  await ensureActorEntitlements(input, tools.map(mcpToolCapabilityId))
  return result(input, "READY", "示範 MCP 已完成真實工具選取、受管連線啟用與簽章發佈。", {
    gatewayId: domain.gatewayId,
    discoveryOperationId: discovery.operation_id,
  })
}
