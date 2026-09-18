import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"

import { PlatformApiError } from "../errors"
import type { ConnectionRegistration } from "../connections/contract"
import type { ResourceConnectionRegistry } from "../connections/module"
import type { ModelEntitlementCatalog } from "../entitlements/module"
import type { OrganizationDirectory } from "../organizations/module"
import type { ProviderCredentialProfileStore } from "../provider-credentials/module"
import type { ResourceRegistration } from "../resources/contract"
import type { ResourceRegistry } from "../resources/module"
import type { UsageGovernanceDirectory } from "../usage-governance/directory"
import type { OnePolicy } from "../one-policy/module"
import type { RuntimePolicyDefinition, RuntimePolicyRevision } from "../one-policy/runtime"
import { CE_DEMO_ID, CE_DEMO_PROMPTS, CE_DEMO_RESOURCE_IDS, CE_DEMO_USE_CASE_ID, CE_DEMO_VERSION } from "../../../../../../packages/protocol/src/ce-demo"
import packages from "../../../../../../packages/protocol/src/ce-demo-package.json" with { type: "json" }
import type { DemoProjectResponse, InstallDemoProjectInput } from "./contract"
import type { DemoLlmProvisioningResult, PrepareDemoLlmInput } from "./llm-provisioning"
import type { DemoInstallationStore } from "./module"
import type { DemoMcpProvisioningResult, PrepareDemoMcpInput } from "./provisioning"

const DEMO_ID = CE_DEMO_ID
const VERSION = CE_DEMO_VERSION
const PACKAGE_RESOURCE_ID = CE_DEMO_RESOURCE_IDS.bot
const GEMINI_BOT_RESOURCE_ID = CE_DEMO_RESOURCE_IDS.geminiBot
const CONTEXT7_RESOURCE_ID = CE_DEMO_RESOURCE_IDS.context7
const ARCHIFY_RESOURCE_ID = CE_DEMO_RESOURCE_IDS.archify
const GEMINI_RESOURCE_ID = CE_DEMO_RESOURCE_IDS.gemini
const GEMINI_CREDENTIAL_PROFILE_ID = "genio.demo.gemini-credential"
const demoPackages = packages as unknown as [
  NonNullable<ResourceRegistration["extension_metadata"]>,
  NonNullable<ResourceRegistration["extension_metadata"]>,
]

const connectionUrl = (resourceId: string) =>
  `/management?view=connections&resource=${encodeURIComponent(resourceId)}`

const prompts: DemoProjectResponse["prompts"] = CE_DEMO_PROMPTS.map((prompt) => ({ ...prompt }))

function provisioningStage(itemId: string, errors: readonly string[]): string | null {
  const prefix = `${itemId}:`
  return errors.find((error) => error.startsWith(prefix))?.slice(prefix.length) ?? null
}

function provisioningDetail(stage: string): string {
  switch (stage) {
    case "GATEWAY_PREREQUISITE":
      return "請完成 Gateway Runtime、registration 與可驗證的發佈 origin，再重送示範設定。"
    case "POLICY_PREREQUISITE":
      return "請先建立並發佈基準 One Policy，再重送示範設定。"
    case "PUBLICATION_PREREQUISITE":
      return "發佈端點尚未可用；請完成 Gateway 網域設定後重送。"
    case "PUBLICATION_PENDING_REVIEW":
      return "正式發佈正在等待簽章或審核完成。"
    case "CONNECTION_DISABLED":
      return "連線已被停用或撤銷；請由管理者明確重新啟用。"
    case "CONNECTION_VERIFICATION_FAILED":
      return "連線驗證失敗，請檢查端點、credential 與網路。"
    case "TOOLS_UNAVAILABLE":
      return "上游 MCP 沒有回報示範所需工具。"
    case "TOOLS_BLOCKED":
      return "示範所需工具已被封鎖。"
    case "TOOLS_IGNORED":
      return "示範所需工具已被略過。"
    case "PUBLICATION_REJECTED":
      return "示範發佈已被拒絕，請由審核者建立新的發佈流程。"
    case "MODEL_CONFIGURATION_CONFLICT":
      return "Gemini 模型或路由政策已有不同設定；為避免覆寫既有設定，請由管理者處理。"
    default:
      return "示範連線尚未完成正式設定。"
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof PlatformApiError && error.code === "RESOURCE_NOT_FOUND"
}

function isConnectionNotFound(error: unknown): boolean {
  return error instanceof PlatformApiError && error.code === "CONNECTION_NOT_FOUND"
}

function isResourceIdConflict(error: unknown): boolean {
  return error instanceof PlatformApiError && error.code === "RESOURCE_ID_EXISTS"
}

function isConnectionIdConflict(error: unknown): boolean {
  return error instanceof PlatformApiError && error.code === "CONNECTION_ID_EXISTS"
}

function isRuntimePolicyNotFound(error: unknown): boolean {
  return error instanceof PlatformApiError && error.code === "RUNTIME_POLICY_NOT_FOUND"
}

function isRuntimePolicyRevisionConflict(error: unknown): boolean {
  return error instanceof PlatformApiError && error.code === "POLICY_REVISION_CONFLICT"
}

function codexSubscriptionPolicyId(organizationId: string, subjectId: string): string {
  return `ce-demo-codex-${createHash("sha256").update(`${organizationId}\0${subjectId}`).digest("hex").slice(0, 32)}`
}

function codexSubscriptionPolicyDefinition(subjectId: string): RuntimePolicyDefinition {
  return {
    display_name: "CE Demo Codex subscription",
    scope: {
      subject_ids: [subjectId],
      organization_ids: [],
      roles: [],
      client_ids: ["genio-one-bot"],
      bot_ids: [],
      runtime_ids: ["codex"],
    },
    rules: [{
      rule_id: "allow-codex-subscription",
      target: { runtime_id: "codex", capability_id: "codex.subscription" },
      actions: ["use"],
      effect: "ALLOW",
      constraints: [],
      obligations: [{ kind: "audit", enforcement_point_id: "AGENT_RUNTIME", parameters: { event_kind: "invoke" } }],
    }, {
      rule_id: "allow-model-invoke",
      target: { runtime_id: "codex", capability_id: "model.invoke" },
      actions: ["invoke"],
      effect: "ALLOW",
      constraints: [],
      obligations: [{ kind: "audit", enforcement_point_id: "AGENT_RUNTIME", parameters: { event_kind: "invoke" } }],
    }],
  }
}

function isExpectedCodexSubscriptionPolicy(
  policy: RuntimePolicyRevision,
  definition: RuntimePolicyDefinition,
): boolean {
  return policy.enabled && policy.display_name === definition.display_name &&
    isDeepStrictEqual(policy.scope, definition.scope) &&
    isDeepStrictEqual(policy.rules, definition.rules)
}

function isLegacyCodexSubscriptionPolicy(
  policy: RuntimePolicyRevision,
  definition: RuntimePolicyDefinition,
): boolean {
  return policy.enabled && policy.display_name === definition.display_name &&
    isDeepStrictEqual(policy.scope, definition.scope) &&
    isDeepStrictEqual(policy.rules, definition.rules.slice(0, 1))
}

function assertResourceIdentity(
  resource: ResourceRegistration,
  organizationId: string,
  kind: ResourceRegistration["kind"],
): void {
  if (resource.owner_organization_id !== organizationId) {
    throw new PlatformApiError("DEMO_PROJECT_ORGANIZATION_CONFLICT", 409)
  }
  if (resource.kind !== kind) {
    throw new PlatformApiError("DEMO_PROJECT_RESOURCE_CONFLICT", 409)
  }
}

function assertConnectionIdentity(
  connection: ConnectionRegistration,
  endpoint: string,
  kind: ConnectionRegistration["connection_kind"],
): void {
  if (connection.connection_kind !== kind || connection.endpoint !== endpoint.replace(/\/$/, "")) {
    throw new PlatformApiError("DEMO_PROJECT_CONNECTION_CONFLICT", 409)
  }
}

function isExplicitlyDisabled(connection: ConnectionRegistration): boolean {
  return connection.lifecycle === "DISABLED" ||
    connection.lifecycle === "REVOKE_PENDING" ||
    connection.lifecycle === "REVOKED"
}

function isExpectedGeminiConnection(connection: ConnectionRegistration, credentialProfileId: string): boolean {
  return connection.connection_kind === "LLM" &&
    connection.provider_type === "GENERIC_OPENAI_COMPATIBLE" &&
    connection.provider_profile_id === "provider-generic-openai-compatible" &&
    connection.provider_credential_profile?.profile_id === credentialProfileId &&
    connection.downstream_identity.mode === "SERVICE" &&
    connection.downstream_identity.authentication === "PROVIDER_CREDENTIAL_PROFILE"
}

export interface DemoProjectServiceOptions {
  organizations: OrganizationDirectory
  resources: ResourceRegistry
  connections: ResourceConnectionRegistry
  entitlements: ModelEntitlementCatalog
  providerCredentials: ProviderCredentialProfileStore
  usageGovernance: UsageGovernanceDirectory
  runtimePolicies: Pick<OnePolicy, "getRuntimePolicy" | "publishRuntimePolicy">
  installations: DemoInstallationStore
  gatewayId: string
  archifyEndpoint: string
  archifyCredentialRef: string | null
  geminiCredentialRef: string | null
  botUrl: string | null
  prepareMcp?: (input: Omit<PrepareDemoMcpInput, "modules" | "gatewayIdentity">) => Promise<DemoMcpProvisioningResult>
  prepareLlm?: (input: Omit<PrepareDemoLlmInput, "modules" | "gatewayIdentity">) => Promise<DemoLlmProvisioningResult>
}

export class DemoProjectService {
  constructor(private readonly options: DemoProjectServiceOptions) {}

  async get(input: { tenantId: string }): Promise<DemoProjectResponse> {
    const installation = await this.options.installations.get({ tenantId: input.tenantId })
    const [context7, archify, gemini, packageResource] = await Promise.all([
      this.resource(input.tenantId, CONTEXT7_RESOURCE_ID),
      this.resource(input.tenantId, ARCHIFY_RESOURCE_ID),
      this.resource(input.tenantId, GEMINI_RESOURCE_ID),
      this.resource(input.tenantId, PACKAGE_RESOURCE_ID),
    ])
    const [context7Connection, archifyConnection, geminiConnection] = await Promise.all([
      this.connection(input.tenantId, CONTEXT7_RESOURCE_ID, "genio.demo.context7"),
      this.connection(input.tenantId, ARCHIFY_RESOURCE_ID, "genio.demo.archify"),
      this.connection(input.tenantId, GEMINI_RESOURCE_ID, "genio.demo.gemini"),
    ])
    const configured = installation?.installation === "INSTALLED"
    return {
      demo_id: DEMO_ID,
      version: VERSION,
      installation: installation?.installation ?? "NOT_INSTALLED",
      organization_id: installation?.organization_id ?? null,
      items: [
        this.mcpItem("context7", "Context7 MCP", CONTEXT7_RESOURCE_ID, context7, context7Connection, installation?.item_errors.includes("context7") ?? false, provisioningStage("context7", installation?.item_errors ?? [])),
        this.archifyItem(archify, archifyConnection, installation?.item_errors.includes("archify") ?? false, provisioningStage("archify", installation?.item_errors ?? [])),
        this.geminiItem(gemini, geminiConnection, installation?.item_errors.includes("gemini") ?? false, provisioningStage("gemini", installation?.item_errors ?? [])),
        this.packageItem(packageResource),
        {
          id: "codex",
          name: "Codex",
          state: configured && this.options.botUrl ? "NEEDS_CONFIGURATION" : "DISABLED",
          detail: this.options.botUrl
            ? "請在 Genio Bot 以個人 Codex 帳號登入後使用。"
            : "Genio Bot 的公開入口尚未設定。",
          ...(this.options.botUrl ? { action_url: this.options.botUrl } : {}),
        },
      ],
      prompts,
      package_resource_id: PACKAGE_RESOURCE_ID,
      bot_url: this.options.botUrl,
    }
  }

  async install(input: {
    tenantId: string
    value: InstallDemoProjectInput
    actorSubjectId: string
  }): Promise<DemoProjectResponse> {
    const existing = await this.options.installations.get({ tenantId: input.tenantId })
    if (existing?.organization_id && existing.organization_id !== input.value.organization_id) {
      throw new PlatformApiError("DEMO_PROJECT_ORGANIZATION_CONFLICT", 409)
    }
    await this.options.organizations.get({
      tenantId: input.tenantId,
      organizationId: input.value.organization_id,
    })
    await this.ensureUseCase(input.tenantId, input.value.organization_id)
    await this.ensureCodexSubscriptionPolicy(input.tenantId, input.value.organization_id, input.actorSubjectId)
    await this.ensureResource(input.tenantId, input.value.organization_id, {
      resourceId: CONTEXT7_RESOURCE_ID,
      display_name: "Context7 MCP",
      kind: "MCP",
      enforcement_point_id: this.options.gatewayId,
      capabilities: [{ capability_id: "context7", display_name: "Context7 文件查詢" }],
    })
    await this.ensureResource(input.tenantId, input.value.organization_id, {
      resourceId: ARCHIFY_RESOURCE_ID,
      display_name: "Archify MCP",
      kind: "MCP",
      enforcement_point_id: this.options.gatewayId,
      capabilities: [{ capability_id: "archify", display_name: "Archify 架構圖" }],
    })
    await this.ensureResource(input.tenantId, input.value.organization_id, {
      resourceId: GEMINI_RESOURCE_ID,
      display_name: "Google Gemini",
      kind: "LLM",
      enforcement_point_id: this.options.gatewayId,
      capabilities: [{ capability_id: "model.invoke", display_name: "Gemini 3.8 Flash" }],
    })
    await this.ensureResource(input.tenantId, input.value.organization_id, {
      resourceId: PACKAGE_RESOURCE_ID,
      display_name: "CE 示範 Bot",
      kind: "EXTENSION",
      capabilities: [{ capability_id: "product-management", display_name: "Product Management" }],
      extension_metadata: demoPackages[0],
    })
    await this.ensureResource(input.tenantId, input.value.organization_id, {
      resourceId: GEMINI_BOT_RESOURCE_ID,
      display_name: "CE Gemini Bot",
      kind: "EXTENSION",
      capabilities: [{ capability_id: "gemini-interviews", display_name: "Gemini 訪談整理" }],
      extension_metadata: demoPackages[1],
    })
    const context7Connection = await this.ensureConnection(input.tenantId, CONTEXT7_RESOURCE_ID, {
      connectionId: "genio.demo.context7",
      display_name: "Context7 MCP",
      connection_kind: "MCP",
      endpoint: "https://mcp.context7.com/mcp",
      mcp_tool_namespace: "context7",
      downstream_identity: { mode: "NONE" },
    })
    let context7Failed = false
    let context7Provisioning: DemoMcpProvisioningResult | null = null
    try {
      if (!isExplicitlyDisabled(context7Connection) && context7Connection.verification_state !== "VERIFIED") {
        await this.options.connections.verify({
          tenantId: input.tenantId,
          resourceId: CONTEXT7_RESOURCE_ID,
          connectionId: context7Connection.connection_id,
        })
      }
    } catch {
      context7Failed = true
    }
    if (!context7Failed && this.options.prepareMcp) {
      context7Provisioning = await this.options.prepareMcp({
        tenantId: input.tenantId,
        organizationId: input.value.organization_id,
        actorSubjectId: input.actorSubjectId,
        resourceId: CONTEXT7_RESOURCE_ID,
        connectionId: context7Connection.connection_id,
        requiredToolNames: ["resolve-library-id", "query-docs"],
      })
    }
    const archifyCredentialRef = this.options.archifyCredentialRef?.trim() || null
    let archifyFailed = false
    let archifyProvisioning: DemoMcpProvisioningResult | null = null
    if (archifyCredentialRef) {
      const archifyConnection = await this.ensureConnection(input.tenantId, ARCHIFY_RESOURCE_ID, {
        connectionId: "genio.demo.archify",
        display_name: "Archify MCP",
        connection_kind: "MCP",
        endpoint: this.options.archifyEndpoint,
        mcp_tool_namespace: "archify",
        credential_ref: archifyCredentialRef,
        downstream_identity: { mode: "SERVICE", authentication: "API_KEY" },
      })
      try {
        if (!isExplicitlyDisabled(archifyConnection) && archifyConnection.verification_state !== "VERIFIED") {
          await this.options.connections.verify({
            tenantId: input.tenantId,
            resourceId: ARCHIFY_RESOURCE_ID,
            connectionId: archifyConnection.connection_id,
          })
        }
      } catch {
        archifyFailed = true
      }
      if (!archifyFailed && this.options.prepareMcp) {
        archifyProvisioning = await this.options.prepareMcp({
          tenantId: input.tenantId,
          organizationId: input.value.organization_id,
          actorSubjectId: input.actorSubjectId,
          resourceId: ARCHIFY_RESOURCE_ID,
          connectionId: archifyConnection.connection_id,
          requiredToolNames: ["archify_schema", "archify_render"],
        })
      }
    }
    const geminiCredentialRef = this.options.geminiCredentialRef?.trim() || null
    const geminiCredentialProfile = geminiCredentialRef
      ? await this.ensureGeminiCredentialProfile(
          input.tenantId,
          input.value.organization_id,
          geminiCredentialRef,
          input.actorSubjectId,
        )
      : null
    let geminiFailed = false
    let geminiProvisioning: DemoLlmProvisioningResult | null = null
    if (geminiCredentialProfile) {
      const geminiConnection = await this.ensureConnection(input.tenantId, GEMINI_RESOURCE_ID, {
        connectionId: "genio.demo.gemini",
        display_name: "Google Gemini OpenAI-compatible",
        connection_kind: "LLM",
        provider_type: "GENERIC_OPENAI_COMPATIBLE",
        provider_profile_id: "provider-generic-openai-compatible",
        endpoint: "https://generativelanguage.googleapis.com/v1beta/openai",
        provider_credential_profile: {
          profile_id: geminiCredentialProfile.profile_id,
          revision: geminiCredentialProfile.revision,
        },
        downstream_identity: { mode: "SERVICE", authentication: "PROVIDER_CREDENTIAL_PROFILE" },
      })
      if (!isExpectedGeminiConnection(geminiConnection, geminiCredentialProfile.profile_id)) {
        geminiProvisioning = {
          stage: "MODEL_CONFIGURATION_CONFLICT",
          detail: "Gemini 受管連線已有不同設定。",
          resourceId: GEMINI_RESOURCE_ID,
          connectionId: geminiConnection.connection_id,
        }
      } else try {
        if (!isExplicitlyDisabled(geminiConnection) && geminiConnection.verification_state !== "VERIFIED") {
          await this.options.connections.verify({
            tenantId: input.tenantId,
            resourceId: GEMINI_RESOURCE_ID,
            connectionId: geminiConnection.connection_id,
          })
        }
      } catch {
        geminiFailed = true
      }
      if (!geminiFailed && !geminiProvisioning && this.options.prepareLlm) {
        geminiProvisioning = await this.options.prepareLlm({
          tenantId: input.tenantId,
          organizationId: input.value.organization_id,
          actorSubjectId: input.actorSubjectId,
          resourceId: GEMINI_RESOURCE_ID,
          connectionId: geminiConnection.connection_id,
          modelName: "gemini-3.8-flash",
        })
      }
    }
    await this.publishExtension(input.tenantId, PACKAGE_RESOURCE_ID)
    await this.publishExtension(input.tenantId, GEMINI_BOT_RESOURCE_ID)
    await this.ensureEntitlement(input.tenantId, input.actorSubjectId, PACKAGE_RESOURCE_ID, "product-management")
    await this.ensureEntitlement(input.tenantId, input.actorSubjectId, GEMINI_BOT_RESOURCE_ID, "gemini-interviews")
    await this.options.installations.saveInstalled({
      tenantId: input.tenantId,
      organizationId: input.value.organization_id,
      resourceIds: [CONTEXT7_RESOURCE_ID, ARCHIFY_RESOURCE_ID, GEMINI_RESOURCE_ID, PACKAGE_RESOURCE_ID, GEMINI_BOT_RESOURCE_ID],
      itemErrors: [
        ...(context7Failed ? ["context7"] : []),
        ...(context7Provisioning && context7Provisioning.stage !== "READY" && context7Provisioning.stage !== "DISCOVERY_PENDING"
          ? [`context7:${context7Provisioning.stage}`]
          : []),
        ...(archifyFailed ? ["archify"] : []),
        ...(archifyProvisioning && archifyProvisioning.stage !== "READY" && archifyProvisioning.stage !== "DISCOVERY_PENDING"
          ? [`archify:${archifyProvisioning.stage}`]
          : []),
        ...(geminiFailed ? ["gemini"] : []),
        ...(geminiProvisioning && geminiProvisioning.stage !== "READY"
          ? [`gemini:${geminiProvisioning.stage}`]
          : []),
      ],
    })
    return this.get({ tenantId: input.tenantId })
  }

  async skip(input: { tenantId: string }): Promise<DemoProjectResponse> {
    await this.options.installations.skip(input)
    return this.get(input)
  }

  private async resource(tenantId: string, resourceId: string): Promise<ResourceRegistration | null> {
    try {
      return await this.options.resources.getResource({ tenantId, resourceId })
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
  }

  private async connection(
    tenantId: string,
    resourceId: string,
    connectionId: string,
  ): Promise<ConnectionRegistration | null> {
    try {
      return await this.options.connections.get({ tenantId, resourceId, connectionId })
    } catch (error) {
      if (isConnectionNotFound(error) || isNotFound(error)) return null
      throw error
    }
  }

  private async ensureResource(
    tenantId: string,
    organizationId: string,
    input: {
      resourceId: string
      display_name: string
      kind: ResourceRegistration["kind"]
      enforcement_point_id?: string
      capabilities: ResourceRegistration["capabilities"]
      extension_metadata?: NonNullable<ResourceRegistration["extension_metadata"]>
    },
  ): Promise<ResourceRegistration> {
    const existing = await this.resource(tenantId, input.resourceId)
    if (existing) {
      assertResourceIdentity(existing, organizationId, input.kind)
      if (input.enforcement_point_id && existing.enforcement_point_id !== input.enforcement_point_id) {
        throw new PlatformApiError("DEMO_PROJECT_RESOURCE_CONFLICT", 409)
      }
      return existing
    }
    try {
      return await this.options.resources.createResource({
        tenantId,
        resourceId: input.resourceId,
        value: {
          display_name: input.display_name,
          kind: input.kind,
          owner_organization_id: organizationId,
          authentication_strategy: "NONE",
          environment_id: "ce-starter",
          version: VERSION,
          capabilities: input.capabilities,
          enforcement_point_id: input.enforcement_point_id ?? "PLATFORM",
          ...(input.extension_metadata ? { extension_metadata: input.extension_metadata } : {}),
        },
      })
    } catch (error) {
      if (!isResourceIdConflict(error)) throw error
      const raced = await this.resource(tenantId, input.resourceId)
      if (!raced) throw error
      assertResourceIdentity(raced, organizationId, input.kind)
      if (input.enforcement_point_id && raced.enforcement_point_id !== input.enforcement_point_id) {
        throw new PlatformApiError("DEMO_PROJECT_RESOURCE_CONFLICT", 409)
      }
      return raced
    }
  }

  private async publishExtension(tenantId: string, resourceId: string): Promise<void> {
    const resource = await this.options.resources.getResource({ tenantId, resourceId })
    if (resource.lifecycle === "PUBLISHED") return
    if (resource.kind !== "EXTENSION" || !resource.extension_metadata) {
      throw new PlatformApiError("DEMO_PROJECT_RESOURCE_CONFLICT", 409)
    }
    await this.options.resources.setLifecycle({ tenantId, resourceId, lifecycle: "PUBLISHED" })
  }

  private async ensureUseCase(tenantId: string, organizationId: string): Promise<void> {
    const active = await this.options.usageGovernance.getActiveUseCase({
      tenant_id: tenantId,
      organization_id: organizationId,
      use_case_id: CE_DEMO_USE_CASE_ID,
    })
    if (active) return
    const existing = await this.options.usageGovernance.listUseCases({
      tenant_id: tenantId,
      organization_id: organizationId,
    })
    if (existing.some((useCase) => useCase.use_case_id === CE_DEMO_USE_CASE_ID)) {
      throw new PlatformApiError("DEMO_PROJECT_USE_CASE_CONFLICT", 409)
    }
    try {
      await this.options.usageGovernance.createUseCase({
        tenant_id: tenantId,
        organization_id: organizationId,
        use_case_id: CE_DEMO_USE_CASE_ID,
        display_name: "CE 示範專案",
        risk_level: "LOW",
        state: "ACTIVE",
        created_at: Math.floor(Date.now() / 1000),
      })
    } catch {
      const raced = await this.options.usageGovernance.getActiveUseCase({
        tenant_id: tenantId,
        organization_id: organizationId,
        use_case_id: CE_DEMO_USE_CASE_ID,
      })
      if (raced) return
      throw new PlatformApiError("DEMO_PROJECT_USE_CASE_CONFLICT", 409)
    }
  }

  private async ensureCodexSubscriptionPolicy(
    tenantId: string,
    organizationId: string,
    subjectId: string,
  ): Promise<void> {
    const policyId = codexSubscriptionPolicyId(organizationId, subjectId)
    const definition = codexSubscriptionPolicyDefinition(subjectId)
    let current: RuntimePolicyRevision | null = null
    try {
      current = await this.options.runtimePolicies.getRuntimePolicy({ tenantId, policyId })
    } catch (error) {
      if (!isRuntimePolicyNotFound(error)) throw error
    }
    if (current && isExpectedCodexSubscriptionPolicy(current, definition)) return
    if (current && !isLegacyCodexSubscriptionPolicy(current, definition)) {
      throw new PlatformApiError("DEMO_PROJECT_RUNTIME_POLICY_CONFLICT", 409)
    }
    try {
      await this.options.runtimePolicies.publishRuntimePolicy({
        tenantId,
        policyId,
        baseRevision: current?.revision ?? 0,
        definition,
        publishedBy: subjectId,
      })
      return
    } catch (error) {
      if (!isRuntimePolicyRevisionConflict(error)) throw error
    }
    const raced = await this.options.runtimePolicies.getRuntimePolicy({ tenantId, policyId })
    if (isExpectedCodexSubscriptionPolicy(raced, definition)) return
    throw new PlatformApiError("DEMO_PROJECT_RUNTIME_POLICY_CONFLICT", 409)
  }

  private async ensureGeminiCredentialProfile(
    tenantId: string,
    organizationId: string,
    credentialRef: string,
    actorSubjectId: string,
  ) {
    const profiles = await this.options.providerCredentials.listLatest({ tenantId })
    const matching = profiles.find((profile) =>
      profile.owner_organization_id === organizationId &&
      profile.state === "ACTIVE" &&
      profile.strategy.kind === "STATIC_SECRET_REFERENCE" &&
      profile.strategy.secret_ref === credentialRef,
    )
    if (matching) return matching
    const named = profiles.find((profile) => profile.profile_id === GEMINI_CREDENTIAL_PROFILE_ID)
    if (named) throw new PlatformApiError("DEMO_PROJECT_GEMINI_CREDENTIAL_CONFLICT", 409)
    try {
      return await this.options.providerCredentials.create({
        tenantId,
        createdBySubjectId: actorSubjectId,
        value: {
          profile_id: GEMINI_CREDENTIAL_PROFILE_ID,
          owner_organization_id: organizationId,
          display_name: "CE Gemini credential",
          strategy: { kind: "STATIC_SECRET_REFERENCE", secret_ref: credentialRef },
        },
      })
    } catch {
      const raced = await this.options.providerCredentials.listLatest({ tenantId })
      const matchingRace = raced.find((profile) =>
        profile.owner_organization_id === organizationId &&
        profile.state === "ACTIVE" &&
        profile.strategy.kind === "STATIC_SECRET_REFERENCE" &&
        profile.strategy.secret_ref === credentialRef,
      )
      if (matchingRace) return matchingRace
      throw new PlatformApiError("DEMO_PROJECT_GEMINI_CREDENTIAL_CONFLICT", 409)
    }
  }

  private async ensureEntitlement(
    tenantId: string,
    subjectId: string,
    resourceId: string,
    capabilityId: string,
  ): Promise<void> {
    const existing = await this.options.entitlements.list({ tenantId })
    if (existing.some((entitlement) =>
      entitlement.state === "ACTIVE" && entitlement.subject_id === subjectId &&
      entitlement.resource_id === resourceId && entitlement.capability_id === capabilityId,
    )) return
    await this.options.entitlements.grant({
      tenantId,
      value: { subject_id: subjectId, resource_id: resourceId, capability_id: capabilityId },
    })
  }

  private async ensureConnection(
    tenantId: string,
    resourceId: string,
    value: Parameters<ResourceConnectionRegistry["create"]>[0]["value"] & { connectionId: string },
  ): Promise<ConnectionRegistration> {
    const existing = await this.connection(tenantId, resourceId, value.connectionId)
    if (existing) {
      assertConnectionIdentity(existing, value.endpoint, value.connection_kind ?? "LLM")
      return existing
    }
    const { connectionId, ...connection } = value
    try {
      return await this.options.connections.create({ tenantId, resourceId, connectionId, value: connection })
    } catch (error) {
      if (!isConnectionIdConflict(error)) throw error
      const raced = await this.connection(tenantId, resourceId, connectionId)
      if (!raced) throw error
      assertConnectionIdentity(raced, value.endpoint, value.connection_kind ?? "LLM")
      return raced
    }
  }

  private mcpItem(
    id: "context7" | "archify",
    name: string,
    resourceId: string,
    resource: ResourceRegistration | null,
    connection: ConnectionRegistration | null,
    failed: boolean,
    stage: string | null,
  ): DemoProjectResponse["items"][number] {
    if (!resource || !connection) {
      return { id, name, state: "DISABLED", detail: "尚未建立示範連線。", resource_id: resourceId, action_url: connectionUrl(resourceId) }
    }
    if (failed || connection.verification_state === "FAILED") {
      return { id, name, state: "ERROR", detail: "連線驗證失敗，請檢查端點與網路連線。", resource_id: resourceId, connection_id: connection.connection_id, action_url: connectionUrl(resourceId) }
    }
    if (stage) {
      const error = ["CONNECTION_VERIFICATION_FAILED", "TOOLS_UNAVAILABLE", "TOOLS_BLOCKED", "TOOLS_IGNORED", "PUBLICATION_REJECTED"].includes(stage)
      return { id, name, state: error ? "ERROR" : "DISABLED", detail: provisioningDetail(stage), resource_id: resourceId, connection_id: connection.connection_id, action_url: connectionUrl(resourceId) }
    }
    if (resource.lifecycle === "PUBLISHED" && connection.lifecycle === "ENABLED" && connection.verification_state === "VERIFIED") {
      return { id, name, state: "READY", detail: "已通過連線驗證並完成正式發佈。", resource_id: resourceId, connection_id: connection.connection_id, action_url: connectionUrl(resourceId) }
    }
    return { id, name, state: "DISABLED", detail: "連線已建立，需完成正式驗證與發佈後啟用。", resource_id: resourceId, connection_id: connection.connection_id, action_url: connectionUrl(resourceId) }
  }

  private geminiItem(
    resource: ResourceRegistration | null,
    connection: ConnectionRegistration | null,
    failed: boolean,
    stage: string | null,
  ): DemoProjectResponse["items"][number] {
    if (!this.options.geminiCredentialRef?.trim() || !resource || !connection || !connection.provider_credential_profile) {
      return { id: "gemini", name: "Google Gemini", state: "NEEDS_CONFIGURATION", detail: "請設定 Gemini API 金鑰，再完成模型驗證與發佈。", resource_id: GEMINI_RESOURCE_ID, ...(connection ? { connection_id: connection.connection_id } : {}), action_url: connectionUrl(GEMINI_RESOURCE_ID) }
    }
    if (failed || connection.verification_state === "FAILED") {
      return { id: "gemini", name: "Google Gemini", state: "ERROR", detail: "Gemini 連線驗證失敗，請檢查受管 credential 與上游服務。", resource_id: GEMINI_RESOURCE_ID, connection_id: connection.connection_id, action_url: connectionUrl(GEMINI_RESOURCE_ID) }
    }
    if (stage) {
      const error = ["CONNECTION_VERIFICATION_FAILED", "MODEL_CONFIGURATION_CONFLICT", "PUBLICATION_REJECTED"].includes(stage)
      return { id: "gemini", name: "Google Gemini", state: error ? "ERROR" : "DISABLED", detail: provisioningDetail(stage), resource_id: GEMINI_RESOURCE_ID, connection_id: connection.connection_id, action_url: connectionUrl(GEMINI_RESOURCE_ID) }
    }
    if (resource.lifecycle === "PUBLISHED" && connection.lifecycle === "ENABLED" && connection.verification_state === "VERIFIED") {
      return { id: "gemini", name: "Google Gemini", state: "READY", detail: "Gemini 連線已完成驗證與正式發佈。", resource_id: GEMINI_RESOURCE_ID, connection_id: connection.connection_id, action_url: connectionUrl(GEMINI_RESOURCE_ID) }
    }
    return { id: "gemini", name: "Google Gemini", state: "DISABLED", detail: "Gemini 已設定，需完成正式驗證與發佈後啟用。", resource_id: GEMINI_RESOURCE_ID, connection_id: connection.connection_id, action_url: connectionUrl(GEMINI_RESOURCE_ID) }
  }

  private archifyItem(
    resource: ResourceRegistration | null,
    connection: ConnectionRegistration | null,
    failed: boolean,
    stage: string | null,
  ): DemoProjectResponse["items"][number] {
    if (!this.options.archifyCredentialRef?.trim()) {
      return { id: "archify", name: "Archify MCP", state: "NEEDS_CONFIGURATION", detail: "Archify service credential 尚未設定。", resource_id: ARCHIFY_RESOURCE_ID, action_url: connectionUrl(ARCHIFY_RESOURCE_ID) }
    }
    return this.mcpItem("archify", "Archify MCP", ARCHIFY_RESOURCE_ID, resource, connection, failed, stage)
  }

  private packageItem(resource: ResourceRegistration | null): DemoProjectResponse["items"][number] {
    if (!resource) {
      return { id: "product-management", name: "Product Management", state: "DISABLED", detail: "尚未建立 CE 示範 Bot 套件。", resource_id: PACKAGE_RESOURCE_ID }
    }
    if (resource.lifecycle === "PUBLISHED" && resource.extension_metadata) {
      return { id: "product-management", name: "Product Management", state: "READY", detail: "CE 示範 Bot 套件已發佈。", resource_id: PACKAGE_RESOURCE_ID }
    }
    return { id: "product-management", name: "Product Management", state: "DISABLED", detail: "CE 示範 Bot 套件待補齊 artifact metadata 並正式發佈。", resource_id: PACKAGE_RESOURCE_ID }
  }
}
