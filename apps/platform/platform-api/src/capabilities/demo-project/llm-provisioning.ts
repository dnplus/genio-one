import type { ResourceConnectionRegistry } from "../connections/module"
import type { ModelEntitlementCatalog } from "../entitlements/module"
import type { EnforcementChainCompiler, EnforcementChainRevisionReader } from "../enforcement/module"
import { PlatformApiError } from "../errors"
import type { GatewayRegistrationLifecycle } from "../gateway-registration/module"
import type { ModelRoutingPolicyStore } from "../model-routing/module"
import type { PublicModelCatalog } from "../models/module"
import type { AiResourcePublicationWorkflow } from "../publications/module"
import type { ResourceRegistry } from "../resources/module"
import type { RuntimeControlStore } from "../runtime-control/contract"
import type { DemoMcpGatewayIdentity, DemoMcpPublicationTarget } from "./provisioning"

export type DemoLlmProvisioningStage =
  | "READY"
  | "CONNECTION_VERIFICATION_FAILED"
  | "CONNECTION_DISABLED"
  | "GATEWAY_PREREQUISITE"
  | "POLICY_PREREQUISITE"
  | "MODEL_CONFIGURATION_CONFLICT"
  | "PUBLICATION_PREREQUISITE"
  | "PUBLICATION_REJECTED"
  | "PUBLICATION_PENDING_REVIEW"

export interface DemoLlmProvisioningResult {
  stage: DemoLlmProvisioningStage
  detail: string
  resourceId: string
  connectionId: string
  modelId?: string
  gatewayId?: string
}

export interface DemoLlmProvisioningModules {
  resources: ResourceRegistry
  connections: ResourceConnectionRegistry
  models: PublicModelCatalog
  modelRoutingPolicies: ModelRoutingPolicyStore
  enforcementCompiler: EnforcementChainCompiler
  enforcementRevisions: EnforcementChainRevisionReader
  publicationWorkflow: AiResourcePublicationWorkflow
  entitlements: ModelEntitlementCatalog
  gatewayRegistrations: Pick<GatewayRegistrationLifecycle, "list">
  runtimeControl: Pick<RuntimeControlStore, "listGatewayRuntimes">
}

export interface PrepareDemoLlmInput {
  tenantId: string
  organizationId: string
  actorSubjectId: string
  resourceId: string
  connectionId: string
  modelName: string
  modules: DemoLlmProvisioningModules
  gatewayIdentity: DemoMcpGatewayIdentity
  publicationTarget?: DemoMcpPublicationTarget
  initialOnePolicyRevision?: number
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
  input: PrepareDemoLlmInput,
  stage: DemoLlmProvisioningStage,
  detail: string,
  extras: Pick<DemoLlmProvisioningResult, "gatewayId" | "modelId"> = {},
): DemoLlmProvisioningResult {
  return {
    stage,
    detail,
    resourceId: input.resourceId,
    connectionId: input.connectionId,
    ...extras,
  }
}

async function selectGatewayDomain(input: PrepareDemoLlmInput): Promise<GatewayPublicationDomain | null> {
  const target = input.publicationTarget
  if (!target) return null
  let origin: URL
  try {
    origin = new URL(target.origin)
  } catch {
    return null
  }
  const [registrations, runtimes] = await Promise.all([
    input.modules.gatewayRegistrations.list({ tenantId: input.tenantId }),
    input.modules.runtimeControl.listGatewayRuntimes({ tenantId: input.tenantId }),
  ])
  const basePath = normalizedBasePath(target.basePath)
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    !origin.hostname ||
    origin.username ||
    origin.password ||
    !basePath ||
    !registrations.some((registration) => registration.gateway_id === target.gatewayId && registration.state === "ACTIVE") ||
    !runtimes.some((runtime) => runtime.target_id === target.gatewayId && runtime.status === "ACTIVE")
  ) return null
  return {
    gatewayId: target.gatewayId,
    hostname: origin.hostname,
    basePath,
    dnsManagement: target.dnsManagement,
    dnsTarget: target.dnsTarget,
  }
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

function routingMatches(modelId: string, policy: {
  mode: string
  candidate_public_model_ids: string[]
  default_public_model_id: string
  session_lease_seconds: number | null
}): boolean {
  return policy.mode === "DETERMINISTIC" &&
    policy.candidate_public_model_ids.length === 1 &&
    policy.candidate_public_model_ids[0] === modelId &&
    policy.default_public_model_id === modelId &&
    policy.session_lease_seconds === null
}

function isLegacyDemoBasePath(input: PrepareDemoLlmInput, path: string): boolean {
  return path === `/models/${input.resourceId}`
}

async function ensureActorEntitlement(input: PrepareDemoLlmInput): Promise<void> {
  const entitlements = await input.modules.entitlements.list({ tenantId: input.tenantId })
  if (entitlements.some((entitlement) =>
    entitlement.state === "ACTIVE" &&
    entitlement.subject_id === input.actorSubjectId &&
    entitlement.resource_id === input.resourceId &&
    entitlement.capability_id === "model.invoke",
  )) return
  await input.modules.entitlements.grant({
    tenantId: input.tenantId,
    value: {
      subject_id: input.actorSubjectId,
      resource_id: input.resourceId,
      capability_id: "model.invoke",
    },
  })
}

export async function prepareDemoLlm(input: PrepareDemoLlmInput): Promise<DemoLlmProvisioningResult> {
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
  if (!resource.capabilities.some((capability) => capability.capability_id === "model.invoke")) {
    return result(input, "MODEL_CONFIGURATION_CONFLICT", "示範 Resource 缺少 model.invoke capability；為避免覆寫既有設定，請建立新的示範 Resource。", { gatewayId: domain.gatewayId })
  }
  const existingChain = await input.modules.enforcementRevisions.getLatest({
    tenantId: input.tenantId,
    resourceId: input.resourceId,
    capabilityId: "model.invoke",
  })
  const onePolicyRevision = existingChain?.one_policy_revision ?? input.initialOnePolicyRevision
  if (!Number.isSafeInteger(onePolicyRevision) || !onePolicyRevision || onePolicyRevision < 1) {
    return result(input, "POLICY_PREREQUISITE", "示範 Resource 尚未有正式 One Policy revision；請先建立並發佈基準 policy 後重送。", { gatewayId: domain.gatewayId })
  }
  if (["DISABLED", "REVOKE_PENDING", "REVOKED"].includes(connection.lifecycle)) {
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
      return result(input, "CONNECTION_VERIFICATION_FAILED", "Gemini 連線尚未通過驗證；請檢查受管 credential、上游服務與網路後重送。", { gatewayId: domain.gatewayId })
    }
  }
  if (verified.lifecycle === "DRAFT") {
    verified = await input.modules.connections.transitionLifecycle({
      tenantId: input.tenantId,
      resourceId: input.resourceId,
      connectionId: input.connectionId,
      value: {
        correlation_id: `ce-demo:${input.resourceId}:${input.connectionId}`,
        expected_revision: verified.configuration_revision,
        command: "ENABLE",
      },
    })
  }
  if (verified.lifecycle !== "ENABLED") {
    return result(input, "CONNECTION_DISABLED", "示範連線未處於啟用狀態；請由管理者檢查連線生命週期。", { gatewayId: domain.gatewayId })
  }
  let models = await input.modules.models.list({
    tenantId: input.tenantId,
    resourceId: input.resourceId,
    visibility: "PUBLIC",
    includeUnpublishedResources: true,
  })
  let model = models.find((candidate) => candidate.model_name === input.modelName) ?? null
  if (!model) {
    try {
      model = await input.modules.models.create({
        tenantId: input.tenantId,
        resourceId: input.resourceId,
        value: {
          model_name: input.modelName,
          display_name: "Gemini 3.8 Flash",
          visibility: "PUBLIC",
          capabilities: ["CHAT", "STREAMING", "TOOL_CALLING"],
          mappings: [{ connection_id: input.connectionId, provider_model: input.modelName }],
        },
      })
    } catch (error) {
      if (!(error instanceof PlatformApiError) || error.code !== "MODEL_NAME_EXISTS") throw error
      models = await input.modules.models.list({
        tenantId: input.tenantId,
        resourceId: input.resourceId,
        visibility: "PUBLIC",
        includeUnpublishedResources: true,
      })
      model = models.find((candidate) => candidate.model_name === input.modelName) ?? null
      if (!model) throw error
    }
  }
  const mappings = await input.modules.models.listMappings({
    tenantId: input.tenantId,
    resourceId: input.resourceId,
    publicModelId: model.model_id,
  })
  const mapping = mappings.find((candidate) => candidate.connection_id === input.connectionId)
  if (mapping && mapping.provider_model !== input.modelName) {
    return result(input, "MODEL_CONFIGURATION_CONFLICT", "Gemini Public Model 已綁定不同的 provider model；為避免覆寫既有設定，請由管理者處理。", { gatewayId: domain.gatewayId, modelId: model.model_id })
  }
  if (!mapping) {
    if (resource.lifecycle !== "DRAFT") {
      return result(input, "MODEL_CONFIGURATION_CONFLICT", "已發佈的 Gemini Resource 缺少所需 Public Model mapping；為避免覆寫既有設定，請由管理者處理。", { gatewayId: domain.gatewayId, modelId: model.model_id })
    }
    await input.modules.models.addMapping({
      tenantId: input.tenantId,
      resourceId: input.resourceId,
      modelId: model.model_id,
      value: {
        connection_id: input.connectionId,
        provider_model: input.modelName,
        expected_connection_revision: verified.configuration_revision,
      },
    })
  }
  const routing = await input.modules.modelRoutingPolicies.getLatest({
    tenantId: input.tenantId,
    ownerOrganizationId: input.organizationId,
    resourceId: input.resourceId,
    capabilityId: "model.invoke",
  })
  if (routing && !routingMatches(model.model_id, routing)) {
    return result(input, "MODEL_CONFIGURATION_CONFLICT", "Gemini 路由政策已由管理者設定；為避免覆寫既有模型選擇，請由管理者處理。", { gatewayId: domain.gatewayId, modelId: model.model_id })
  }
  if (!routing) {
    await input.modules.modelRoutingPolicies.save({
      tenantId: input.tenantId,
      value: {
        owner_organization_id: input.organizationId,
        resource_id: input.resourceId,
        capability_id: "model.invoke",
        routing_revision: 1,
        mode: "DETERMINISTIC",
        candidate_public_model_ids: [model.model_id],
        default_public_model_id: model.model_id,
        session_lease_seconds: null,
      },
    })
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
    return result(input, "PUBLICATION_PREREQUISITE", "Gemini Resource 尚未有可用發佈端點；請完成 Gateway 網域設定後重送。", { gatewayId: domain.gatewayId, modelId: model.model_id })
  }
  if (current.lifecycle === "DRAFT") {
    const endpoint = current.publication_endpoint!
    if (endpoint.gateway_id !== domain.gatewayId || endpoint.hostname !== domain.hostname || endpoint.base_path !== expectedPath) {
      return result(input, "PUBLICATION_PREREQUISITE", "Gemini Resource 已有不同的發佈端點；為避免覆寫既有設定，請使用該端點完成發佈。", { gatewayId: domain.gatewayId, modelId: model.model_id })
    }
    if (!existingChain) {
      const compiled = await input.modules.enforcementCompiler.compile({
        tenantId: input.tenantId,
        value: {
          resource_id: input.resourceId,
          capability_id: "model.invoke",
          eligible_connection_ids: [input.connectionId],
          one_policy_revision: onePolicyRevision,
          steps: defaultSteps(input.gatewayIdentity),
        },
      })
      await input.modules.enforcementRevisions.save({ tenantId: input.tenantId, chain: compiled })
    }
    if (current.publication_request?.state === "REJECTED") {
      return result(input, "PUBLICATION_REJECTED", "Gemini 發佈曾被拒絕；請由審核者建立新的發佈流程。", { gatewayId: domain.gatewayId, modelId: model.model_id })
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
        return result(input, "PUBLICATION_PENDING_REVIEW", "Gemini 發佈正在進行簽章與套用；完成後請重送示範設定。", { gatewayId: domain.gatewayId, modelId: model.model_id })
      }
      throw error
    }
  }
  if (current.lifecycle !== "PUBLISHED") {
    return result(input, "PUBLICATION_PENDING_REVIEW", "Gemini 發佈尚未完成；請等待 Gateway 簽章與套用後重送示範設定。", { gatewayId: domain.gatewayId, modelId: model.model_id })
  }
  await ensureActorEntitlement(input)
  return result(input, "READY", "Gemini Public Model、路由政策、enforcement chain 與正式發佈已完成。", { gatewayId: domain.gatewayId, modelId: model.model_id })
}
