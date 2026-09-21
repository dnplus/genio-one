import { Check } from "typebox/value"

import type {
  CompiledAuthorizationBundle,
  CompiledAgentDelegation,
  CompiledExecutionGrant,
  CompiledAuthorizationRule,
  CompiledSubjectContext,
  CompiledUsageContext,
  CompiledUsagePolicy,
} from "@genioone/protocol/authorization"
import { isCompiledAuthorizationBundle } from "../../../../../../runtimes/gateway/services/authorizer/signed-bundle"
import {
  PROCESSOR_POLICY_BUNDLE_SCHEMA_VERSION,
  validateProcessorPolicyBundle,
  type ProcessorHook,
  type ProcessorPolicyBundle,
  type ProcessorPolicyScope,
  type ProcessorPolicyStep,
} from "../../../../../../runtimes/gateway/services/processor/contract"
import {
  CompiledEnforcementChainSchema,
  type CompiledEnforcementChain,
  type ProcessStep,
} from "../enforcement/contract"
import { validateCompiledEnforcementChainSemantics } from "../enforcement/compiler"
import {
  ModelEntitlementSchema,
  type ModelEntitlement,
} from "../entitlements/contract"
import {
  PublicModelSchema,
  type PublicModel,
} from "../models/contract"
import {
  GatewayProjectionSchema,
  type GatewayProjection,
} from "../gateway-projection/contract"
import { mcpToolCapabilityId } from "../../../../../../runtimes/gateway/services/shared/mcp-tool-capability"
import type { GatewayRoutingResourceOwnerRef } from "./routing-compiler"
import { compareUtf8 } from "@genioone/protocol/canonical"

/**
 * The compiler consumes one frozen, already-resolved Gateway projection set.
 * It deliberately has no repository dependency: the publication transaction
 * owns the snapshot and supplies all of its rows before this function runs.
 */
export interface GatewayPolicyArtifactCompilerInput {
  tenant_id: string
  gateway_id: string
  revision: string
  policy_version: string
  issued_at: number
  expires_at: number
  projections: readonly GatewayProjection[]
  enforcement_chains: readonly CompiledEnforcementChain[]
  public_models: readonly PublicModel[]
  entitlements: readonly ModelEntitlement[]
  subject_aliases?: Readonly<Record<string, readonly string[]>>
  subject_contexts?: readonly CompiledSubjectContext[]
  agent_delegations?: readonly CompiledAgentDelegation[]
  execution_grants?: readonly CompiledExecutionGrant[]
  usage_policies?: readonly CompiledUsagePolicy[]
  usage_contexts?: readonly CompiledUsageContext[]
  resource_owners?: readonly GatewayRoutingResourceOwnerRef[]
}

export interface CompiledGatewayPolicyArtifacts {
  authorization_bundle: CompiledAuthorizationBundle
  processor_policy: ProcessorPolicyBundle
}

function identifier(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    /[\u0000\r\n]/.test(value)
  ) {
    throw new Error(`${label} is invalid`)
  }
}

function safeTimestamp(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} is invalid`)
  }
}

function principalIdentifier(value: string, label: string): void {
  identifier(value, label)
  if (value === "*") throw new Error(`${label} cannot use the reserved wildcard`)
}

function compareTuple(left: readonly string[], right: readonly string[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference = compareUtf8(left[index]!, right[index]!)
    if (difference !== 0) return difference
  }
  return left.length - right.length
}

function expandedUsageContexts(
  contexts: readonly CompiledUsageContext[],
  subjectAliases: Readonly<Record<string, readonly string[]>>,
): CompiledUsageContext[] {
  const expanded = new Map<string, CompiledUsageContext>()
  for (const context of contexts) {
    const subjectIds = [context.subject_id, ...(subjectAliases[context.subject_id] ?? [])]
    for (const subjectId of subjectIds) {
      principalIdentifier(subjectId, `usage_contexts.${context.subject_id}.subject_id`)
      const value = { ...context, subject_id: subjectId }
      expanded.set(
        `${value.subject_id}\u0000${value.consumer_organization_id}\u0000${value.use_case_id}`,
        value,
      )
    }
  }
  return [...expanded.values()]
}

function expandedSubjectContexts(
  contexts: readonly CompiledSubjectContext[],
  subjectAliases: Readonly<Record<string, readonly string[]>>,
): CompiledSubjectContext[] {
  const expanded = new Map<string, CompiledSubjectContext>()
  for (const context of contexts) {
    principalIdentifier(context.subject_id, "subject_contexts.subject_id")
    if (context.kind !== "PERSON" && context.kind !== "APPLICATION" && context.kind !== "AGENT") {
      throw new Error("subject_contexts.kind is invalid")
    }
    for (const subjectId of [context.subject_id, ...(subjectAliases[context.subject_id] ?? [])]) {
      principalIdentifier(subjectId, `subject_contexts.${context.subject_id}.subject_id`)
      const existing = expanded.get(subjectId)
      if (existing && existing.kind !== context.kind) {
        throw new Error(`subject context alias ${subjectId} has conflicting kinds`)
      }
      expanded.set(subjectId, { subject_id: subjectId, kind: context.kind })
    }
  }
  return [...expanded.values()].sort((left, right) => compareUtf8(left.subject_id, right.subject_id))
}

function compiledAgentDelegations(
  delegations: readonly CompiledAgentDelegation[],
  subjectContexts: readonly CompiledSubjectContext[],
  projections: readonly GatewayProjection[],
): CompiledAgentDelegation[] {
  const subjects = new Map(subjectContexts.map((context) => [context.subject_id, context.kind]))
  const capabilities = new Set<string>()
  for (const projection of projections) {
    capabilities.add(projectionKey(projection))
    for (const tool of publishedMcpTools(projection)) {
      capabilities.add(`${projection.resource_id}\u0000${mcpToolCapabilityId(tool.canonicalName)}`)
    }
  }
  const ids = new Set<string>()
  for (const [index, delegation] of delegations.entries()) {
    principalIdentifier(delegation.delegation_id, `agent_delegations[${index}].delegation_id`)
    principalIdentifier(delegation.principal_subject_id, `agent_delegations[${index}].principal_subject_id`)
    principalIdentifier(delegation.agent_subject_id, `agent_delegations[${index}].agent_subject_id`)
    principalIdentifier(delegation.resource_id, `agent_delegations[${index}].resource_id`)
    safeTimestamp(delegation.revision, `agent_delegations[${index}].revision`)
    safeTimestamp(delegation.starts_at, `agent_delegations[${index}].starts_at`)
    safeTimestamp(delegation.expires_at, `agent_delegations[${index}].expires_at`)
    safeTimestamp(delegation.revocation_generation, `agent_delegations[${index}].revocation_generation`)
    if (delegation.revision < 1 || delegation.expires_at <= delegation.starts_at) {
      throw new Error(`agent_delegations[${index}] revision or window is invalid`)
    }
    if (ids.has(delegation.delegation_id)) {
      throw new Error(`agent_delegations contains duplicate delegation_id: ${delegation.delegation_id}`)
    }
    ids.add(delegation.delegation_id)
    if (!subjects.has(delegation.principal_subject_id) || subjects.get(delegation.agent_subject_id) !== "AGENT") {
      throw new Error(`agent_delegations[${index}] subjects are not present in signed Subject Context`)
    }
    if (delegation.capability_ids.length === 0 || new Set(delegation.capability_ids).size !== delegation.capability_ids.length) {
      throw new Error(`agent_delegations[${index}].capability_ids is invalid`)
    }
    for (const capabilityId of delegation.capability_ids) {
      principalIdentifier(capabilityId, `agent_delegations[${index}].capability_ids`)
      if (!capabilities.has(`${delegation.resource_id}\u0000${capabilityId}`)) {
        throw new Error(`agent_delegations[${index}] Capability does not map to an active Gateway projection`)
      }
    }
    if (delegation.acting_client_ids.length === 0 || new Set(delegation.acting_client_ids).size !== delegation.acting_client_ids.length) {
      throw new Error(`agent_delegations[${index}].acting_client_ids is invalid`)
    }
    for (const actingClientId of delegation.acting_client_ids) {
      principalIdentifier(actingClientId, `agent_delegations[${index}].acting_client_ids`)
    }
  }
  return [...delegations].sort((left, right) => compareUtf8(left.delegation_id, right.delegation_id))
}

function compiledExecutionGrants(
  grants: readonly CompiledExecutionGrant[],
  subjectContexts: readonly CompiledSubjectContext[],
  projections: readonly GatewayProjection[],
): CompiledExecutionGrant[] {
  const subjects = new Set(subjectContexts.map((context) => context.subject_id))
  const capabilities = new Set(projections.map(projectionKey))
  const ids = new Set<string>()
  for (const [index, grant] of grants.entries()) {
    principalIdentifier(grant.execution_grant_id, `execution_grants[${index}].execution_grant_id`)
    principalIdentifier(grant.subject_id, `execution_grants[${index}].subject_id`)
    principalIdentifier(grant.acting_client_id, `execution_grants[${index}].acting_client_id`)
    principalIdentifier(grant.resource_id, `execution_grants[${index}].resource_id`)
    principalIdentifier(grant.capability_id, `execution_grants[${index}].capability_id`)
    principalIdentifier(grant.issued_by_subject_id, `execution_grants[${index}].issued_by_subject_id`)
    safeTimestamp(grant.issued_at, `execution_grants[${index}].issued_at`)
    safeTimestamp(grant.expires_at, `execution_grants[${index}].expires_at`)
    if (!/^[a-f0-9]{64}$/.test(grant.action_digest) || grant.expires_at <= grant.issued_at) {
      throw new Error(`execution_grants[${index}] digest or window is invalid`)
    }
    if (ids.has(grant.execution_grant_id)) throw new Error(`execution_grants contains duplicate execution_grant_id: ${grant.execution_grant_id}`)
    ids.add(grant.execution_grant_id)
    if (!subjects.has(grant.subject_id) || !capabilities.has(`${grant.resource_id}\u0000${grant.capability_id}`)) {
      throw new Error(`execution_grants[${index}] authority does not map to signed Subject and Capability context`)
    }
  }
  return [...grants].sort((left, right) => compareUtf8(left.execution_grant_id, right.execution_grant_id))
}

function projectionKey(projection: Pick<GatewayProjection, "resource_id" | "capability_id">): string {
  return `${projection.resource_id}\u0000${projection.capability_id}`
}

interface PublishedMcpTool {
  canonicalName: string
  exposedName: string
}

function publishedMcpTools(projection: GatewayProjection): PublishedMcpTool[] {
  const tools = projection.resources
    .filter((resource) => resource.kind === "MCPRoute")
    .flatMap((resource) => Array.isArray(resource.spec?.backendRefs) ? resource.spec.backendRefs : [])
    .flatMap((reference) => {
      if (!reference || typeof reference !== "object" || Array.isArray(reference)) return []
      const backendReference = reference as { name?: unknown; toolSelector?: unknown }
      const selector = backendReference.toolSelector
      if (!selector || typeof selector !== "object" || Array.isArray(selector)) return []
      const include = (selector as { include?: unknown }).include
      if (!Array.isArray(include)) return []
      const namespace = typeof backendReference.name === "string" && backendReference.name
        ? `${backendReference.name}__`
        : ""
      return include
        .filter((tool): tool is string => typeof tool === "string")
        .map((tool) => ({ canonicalName: tool, exposedName: `${namespace}${tool}` }))
    })
  return [...new Map(tools.map((tool) => [tool.exposedName, tool])).values()]
    .sort((left, right) => compareUtf8(left.exposedName, right.exposedName))
}

function assertProjectionShape(
  projection: GatewayProjection,
  tenantId: string,
  gatewayId: string,
  index: number,
): asserts projection is GatewayProjection & { operation: "APPLY" } {
  if (!Check(GatewayProjectionSchema, projection)) {
    throw new Error(`projection[${index}] is invalid`)
  }
  if (projection.operation !== "APPLY") {
    throw new Error(`projection[${index}] must be an APPLY projection`)
  }
  identifier(projection.projection_id, `projection[${index}].projection_id`)
  identifier(projection.publication_id, `projection[${index}].publication_id`)
  identifier(projection.tenant_id, `projection[${index}].tenant_id`)
  if (projection.tenant_id !== tenantId) {
    throw new Error(`projection[${index}] tenant does not match compiler tenant`)
  }
  if (projection.publication_endpoint.gateway_id !== gatewayId) {
    throw new Error(`projection[${index}] Gateway does not match compiler Gateway`)
  }
  identifier(projection.resource_id, `projection[${index}].resource_id`)
  identifier(projection.capability_id, `projection[${index}].capability_id`)

  const chain = projection.policy_bundle?.enforcement_chain
  if (!chain || !Check(CompiledEnforcementChainSchema, chain)) {
    throw new Error(`projection[${index}] enforcement chain is invalid`)
  }
  assertChainShape(chain, tenantId, projection, index)
  validateCompiledEnforcementChainSemantics(chain)
  if (chain.one_policy_revision !== projection.policy_revision) {
    throw new Error(`projection[${index}] enforcement chain revision does not match projection`)
  }
}

function assertChainShape(
  chain: CompiledEnforcementChain,
  tenantId: string,
  projection: Pick<GatewayProjection, "resource_id" | "capability_id">,
  projectionIndex: number,
): void {
  identifier(chain.chain_id, `projection[${projectionIndex}].chain_id`)
  identifier(chain.tenant_id, `projection[${projectionIndex}].chain.tenant_id`)
  identifier(chain.resource_id, `projection[${projectionIndex}].chain.resource_id`)
  identifier(chain.capability_id, `projection[${projectionIndex}].chain.capability_id`)
  if (chain.tenant_id !== tenantId) {
    throw new Error(`projection[${projectionIndex}] enforcement chain tenant does not match`)
  }
  if (
    chain.resource_id !== projection.resource_id ||
    chain.capability_id !== projection.capability_id
  ) {
    throw new Error(`projection[${projectionIndex}] enforcement chain mapping does not match`)
  }
  if (!Number.isSafeInteger(chain.one_policy_revision) || chain.one_policy_revision < 1) {
    throw new Error(`projection[${projectionIndex}] enforcement chain revision is invalid`)
  }
}

function assertModelShape(model: PublicModel, tenantId: string, index: number): void {
  if (!Check(PublicModelSchema, model)) {
    throw new Error(`public_models[${index}] is invalid`)
  }
  identifier(model.tenant_id, `public_models[${index}].tenant_id`)
  if (model.tenant_id !== tenantId) {
    throw new Error(`public_models[${index}] tenant does not match compiler tenant`)
  }
  identifier(model.model_id, `public_models[${index}].model_id`)
  identifier(model.model_name, `public_models[${index}].model_name`)
  identifier(model.resource_id, `public_models[${index}].resource_id`)
  if (model.lifecycle !== "PUBLISHED") {
    throw new Error(`public_models[${index}] is not published`)
  }
}

function assertEntitlementShape(
  entitlement: ModelEntitlement,
  tenantId: string,
  index: number,
): void {
  if (!Check(ModelEntitlementSchema, entitlement)) {
    throw new Error(`entitlements[${index}] is invalid`)
  }
  identifier(entitlement.tenant_id, `entitlements[${index}].tenant_id`)
  if (entitlement.tenant_id !== tenantId) {
    throw new Error(`entitlements[${index}] tenant does not match compiler tenant`)
  }
  identifier(entitlement.entitlement_id, `entitlements[${index}].entitlement_id`)
  if (entitlement.subject_id !== null) {
    principalIdentifier(entitlement.subject_id, `entitlements[${index}].subject_id`)
  }
  if (entitlement.client_id !== null) {
    principalIdentifier(entitlement.client_id, `entitlements[${index}].client_id`)
  }
  identifier(entitlement.resource_id, `entitlements[${index}].resource_id`)
  identifier(entitlement.capability_id, `entitlements[${index}].capability_id`)
  if (entitlement.public_model_id !== null) {
    identifier(entitlement.public_model_id, `entitlements[${index}].public_model_id`)
  }
  safeTimestamp(entitlement.starts_at, `entitlements[${index}].starts_at`)
  if (entitlement.expires_at !== null) {
    safeTimestamp(entitlement.expires_at, `entitlements[${index}].expires_at`)
    if (entitlement.expires_at <= entitlement.starts_at) {
      throw new Error(`entitlements[${index}] expiry is invalid`)
    }
  }
}

function isActiveEntitlement(entitlement: ModelEntitlement, issuedAt: number): boolean {
  return (
    entitlement.state === "ACTIVE" &&
    entitlement.starts_at <= issuedAt &&
    (entitlement.expires_at === null || issuedAt < entitlement.expires_at)
  )
}

function processHook(hook: ProcessStep["hooks"]["request"]): ProcessorHook | undefined {
  if (!hook) return undefined
  const result: ProcessorHook = { action: hook.action }
  if (hook.effect !== undefined) result.effect = hook.effect
  if (hook.config !== undefined) result.config = hook.config
  return result
}

function compileProcessorScope(
  projection: GatewayProjection & { operation: "APPLY" },
  chain: CompiledEnforcementChain,
  projectionIndex: number,
): ProcessorPolicyScope | undefined {
  const processSteps: ProcessStep[] = []
  for (const [stepIndex, step] of chain.steps.entries()) {
    if (step.kind !== "PROCESS") continue
    if (step.implementation !== "PROCESSOR") {
      throw new Error(
        `projection[${projectionIndex}].chain.steps[${stepIndex}] PROCESS implementation is unsupported`,
      )
    }
    processSteps.push(step)
  }
  if (processSteps.length === 0) return undefined
  const hasProcessorSeam = projection.resources.some((resource) =>
    resource.kind === "EnvoyExtensionPolicy" &&
    (Array.isArray(resource.spec?.lua) || Array.isArray(resource.spec?.extProc))
  )
  if (!hasProcessorSeam) {
    throw new Error(
      `projection[${projectionIndex}] cannot execute PROCESS steps without a processor seam`,
    )
  }

  const steps: ProcessorPolicyStep[] = processSteps.map((step) => {
    const request = processHook(step.hooks.request)
    const response = processHook(step.hooks.response)
    const hooks: ProcessorPolicyStep["hooks"] = {}
    if (request) hooks.request = request
    if (response) hooks.response = response
    return { step_id: step.step_id, hooks }
  })

  return {
    resource_id: chain.resource_id,
    capability_id: chain.capability_id,
    steps,
  }
}

function compileAuthorizationRules(
  tenantId: string,
  gatewayId: string,
  issuedAt: number,
  projections: readonly (GatewayProjection & { operation: "APPLY" })[],
  publicModels: readonly PublicModel[],
  entitlements: readonly ModelEntitlement[],
  subjectAliases: Readonly<Record<string, readonly string[]>>,
  chains: ReadonlyMap<string, CompiledEnforcementChain>,
): { rules: CompiledAuthorizationRule[]; expiresAt: number | null } {
  const modelsById = new Map<string, PublicModel>()
  const modelNames = new Set<string>()
  for (const [index, model] of publicModels.entries()) {
    assertModelShape(model, tenantId, index)
    if (modelsById.has(model.model_id)) {
      throw new Error(`public_models contains duplicate model_id: ${model.model_id}`)
    }
    if (modelNames.has(model.model_name)) {
      throw new Error(`public_models contains duplicate model_name: ${model.model_name}`)
    }
    modelsById.set(model.model_id, model)
    modelNames.add(model.model_name)
  }

  const projectionByResource = new Map<string, (GatewayProjection & { operation: "APPLY" })>()
  const projectionMappings = new Set<string>()
  const projectionIds = new Set<string>()
  for (const [index, projection] of projections.entries()) {
    assertProjectionShape(projection, tenantId, gatewayId, index)
    const mapping = projectionKey(projection)
    if (projectionMappings.has(mapping)) {
      throw new Error(`projections contains duplicate resource/capability mapping: ${mapping}`)
    }
    projectionMappings.add(mapping)
    if (projectionIds.has(projection.projection_id)) {
      throw new Error(`projections contains duplicate projection_id: ${projection.projection_id}`)
    }
    projectionIds.add(projection.projection_id)
    if (projectionByResource.has(projection.resource_id)) {
      throw new Error(
        `projections contain ambiguous resource mapping: ${projection.resource_id}`,
      )
    }
    projectionByResource.set(projection.resource_id, projection)
  }

  const entitlementIds = new Set<string>()
  const rules: CompiledAuthorizationRule[] = []
  let expiresAt: number | null = null
  for (const [index, entitlement] of entitlements.entries()) {
    assertEntitlementShape(entitlement, tenantId, index)
    if (entitlementIds.has(entitlement.entitlement_id)) {
      throw new Error(
        `entitlements contains duplicate entitlement_id: ${entitlement.entitlement_id}`,
      )
    }
    entitlementIds.add(entitlement.entitlement_id)
    if (!isActiveEntitlement(entitlement, issuedAt)) continue
    if (entitlement.expires_at !== null) {
      expiresAt = expiresAt === null
        ? entitlement.expires_at
        : Math.min(expiresAt, entitlement.expires_at)
    }
    if (entitlement.subject_id === null && entitlement.client_id === null) {
      throw new Error(
        `entitlements[${index}] must identify a subject or client before wildcard compilation`,
      )
    }

    const model = entitlement.public_model_id === null
      ? null
      : modelsById.get(entitlement.public_model_id)
    if (entitlement.public_model_id !== null && !model) {
      throw new Error(`entitlements[${index}] references an unknown public model: ${entitlement.public_model_id}`)
    }
    if (model && model.resource_id !== entitlement.resource_id) {
      throw new Error(`entitlements[${index}] public model does not belong to its Resource`)
    }
    const projection = projectionByResource.get(entitlement.resource_id)
    if (!projection) {
      throw new Error(`entitlements[${index}] Resource does not map to an active Gateway projection`)
    }
    const mcpTools = publishedMcpTools(projection)
    const entitledMcpTool = mcpTools.find((tool) =>
      mcpToolCapabilityId(tool.canonicalName) === entitlement.capability_id,
    )
    if (projection.capability_id !== entitlement.capability_id && !entitledMcpTool) {
      throw new Error(`entitlements[${index}] Capability does not match its Gateway projection`)
    }

    const canonicalSubject = entitlement.subject_id
    const aliases = canonicalSubject === null ? [] : [...(subjectAliases[canonicalSubject] ?? [])]
    for (const [aliasIndex, alias] of aliases.entries()) {
      principalIdentifier(alias, `subject_aliases.${canonicalSubject}[${aliasIndex}]`)
    }
    const subjectIds = canonicalSubject === null
      ? ["*"]
      : [...new Set([canonicalSubject, ...aliases])].sort(compareUtf8)
    const requiredObligations = (chains.get(projectionKey(projection))?.steps ?? [])
      .flatMap((step) => {
        if (step.kind !== "AUTHORIZE" || !step.config || !("required_obligations" in step.config)) return []
        const value = step.config.required_obligations
        if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
          throw new Error(`authorization required_obligations is invalid for ${projectionKey(projection)}`)
        }
        return value
      })
    const canonicalRequiredObligations = [...new Set(requiredObligations)].sort(compareUtf8)
    rules.push({
      rule_id: entitlement.entitlement_id,
      disposition: "ALLOW",
      subject_ids: subjectIds,
      acting_client_ids: [entitlement.client_id ?? "*"],
      resource_id: projection.resource_id,
      capability_id: entitlement.capability_id,
      public_models: model ? [model.model_name] : [],
      ...(mcpTools.length > 0
        ? { mcp_tools: entitledMcpTool ? [entitledMcpTool.exposedName] : mcpTools.map((tool) => tool.exposedName) }
        : {}),
      ...(canonicalRequiredObligations.length > 0
        ? { required_obligations: canonicalRequiredObligations }
        : {}),
    })
  }

  return {
    rules: rules.sort((left, right) =>
      compareTuple(
        [
          left.rule_id,
          left.resource_id,
          left.capability_id,
          left.subject_ids[0]!,
          left.acting_client_ids[0]!,
          left.public_models[0] ?? "",
        ],
        [
          right.rule_id,
          right.resource_id,
          right.capability_id,
          right.subject_ids[0]!,
          right.acting_client_ids[0]!,
          right.public_models[0] ?? "",
        ],
      ),
    ),
    expiresAt,
  }
}

function compileProcessorPolicy(
  tenantId: string,
  revision: string,
  policyVersion: string,
  issuedAt: number,
  expiresAt: number,
  projections: readonly (GatewayProjection & { operation: "APPLY" })[],
  chains: ReadonlyMap<string, CompiledEnforcementChain>,
): ProcessorPolicyBundle {
  const scopes = projections
    .map((projection, index) => compileProcessorScope(
      projection,
      chains.get(projectionKey(projection))!,
      index,
    ))
    .filter((scope): scope is ProcessorPolicyScope => scope !== undefined)
    .sort((left, right) =>
      compareTuple(
        [left.resource_id, left.capability_id],
        [right.resource_id, right.capability_id],
      ),
    )

  return validateProcessorPolicyBundle({
    schema_version: PROCESSOR_POLICY_BUNDLE_SCHEMA_VERSION,
    tenant_id: tenantId,
    revision,
    policy_version: policyVersion,
    issued_at: issuedAt,
    expires_at: expiresAt,
    scopes,
  })
}

function currentChains(
  tenantId: string,
  projections: readonly (GatewayProjection & { operation: "APPLY" })[],
  chains: readonly CompiledEnforcementChain[],
): ReadonlyMap<string, CompiledEnforcementChain> {
  const projectionsByKey = new Map(projections.map((projection) => [projectionKey(projection), projection]))
  const result = new Map<string, CompiledEnforcementChain>()
  for (const [index, chain] of chains.entries()) {
    if (!Check(CompiledEnforcementChainSchema, chain)) {
      throw new Error(`enforcement_chains[${index}] is invalid`)
    }
    const key = projectionKey(chain)
    const projection = projectionsByKey.get(key)
    if (!projection) {
      throw new Error(`enforcement_chains[${index}] does not map to an active projection`)
    }
    if (result.has(key)) {
      throw new Error(`enforcement_chains contains duplicate scope: ${key}`)
    }
    assertChainShape(chain, tenantId, projection, index)
    validateCompiledEnforcementChainSemantics(chain)
    result.set(key, chain)
  }
  if (result.size !== projections.length) {
    throw new Error("every active projection requires one current enforcement chain")
  }
  return result
}

/**
 * Compile the frozen policy view into the two artifacts consumed by the
 * Gateway sidecars. The function is intentionally fail-closed: an ambiguous
 * resource/projection mapping, unpublished model, unsupported processor hook,
 * or cross-tenant row cannot produce a partially valid release.
 */
export function compileGatewayPolicyArtifacts(
  input: GatewayPolicyArtifactCompilerInput,
): CompiledGatewayPolicyArtifacts {
  identifier(input.tenant_id, "tenant_id")
  identifier(input.gateway_id, "gateway_id")
  identifier(input.revision, "revision")
  identifier(input.policy_version, "policy_version")
  safeTimestamp(input.issued_at, "issued_at")
  safeTimestamp(input.expires_at, "expires_at")
  if (input.expires_at <= input.issued_at) {
    throw new Error("expires_at must be after issued_at")
  }
  if (!Array.isArray(input.projections)) throw new Error("projections must be an array")
  if (!Array.isArray(input.enforcement_chains)) throw new Error("enforcement_chains must be an array")
  if (!Array.isArray(input.public_models)) throw new Error("public_models must be an array")
  if (!Array.isArray(input.entitlements)) throw new Error("entitlements must be an array")

  const projections: (GatewayProjection & { operation: "APPLY" })[] = []
  for (const [index, projection] of input.projections.entries()) {
    assertProjectionShape(projection, input.tenant_id, input.gateway_id, index)
    projections.push(projection)
  }
  const chains = currentChains(input.tenant_id, projections, input.enforcement_chains)

  const compiledAuthorization = compileAuthorizationRules(
    input.tenant_id,
    input.gateway_id,
    input.issued_at,
    projections,
    input.public_models,
    input.entitlements,
    input.subject_aliases ?? {},
    chains,
  )
  const effectiveExpiresAt = compiledAuthorization.expiresAt === null
    ? input.expires_at
    : Math.min(input.expires_at, compiledAuthorization.expiresAt)
  const subjectContexts = expandedSubjectContexts(
    input.subject_contexts ?? [],
    input.subject_aliases ?? {},
  )
  const agentDelegations = compiledAgentDelegations(
    input.agent_delegations ?? [],
    subjectContexts,
    projections,
  )
  const executionGrants = compiledExecutionGrants(
    input.execution_grants ?? [],
    subjectContexts,
    projections,
  )
  const authorization_bundle: CompiledAuthorizationBundle = {
    schema_version: 1,
    tenant_id: input.tenant_id,
    revision: input.revision,
    policy_version: input.policy_version,
    issued_at: input.issued_at,
    expires_at: effectiveExpiresAt,
    rules: compiledAuthorization.rules,
    revoked_entitlement_ids: input.entitlements
      .filter((entitlement) => entitlement.state === "REVOKED")
      .map((entitlement) => entitlement.entitlement_id)
      .sort(compareUtf8),
    usage_policies: [...(input.usage_policies ?? [])]
      .sort((left, right) => compareTuple(
        [left.usage_policy_id, String(left.revision)],
        [right.usage_policy_id, String(right.revision)],
      ))
      .map((policy): CompiledUsagePolicy => ({
        usage_policy_id: policy.usage_policy_id,
        revision: policy.revision,
        accounting_key_id: policy.accounting_key_id,
        selectors: policy.selectors,
        limits: policy.limits,
      })),
    usage_contexts: expandedUsageContexts(
      input.usage_contexts ?? [],
      input.subject_aliases ?? {},
    )
      .sort((left, right) => compareTuple(
        [left.subject_id, left.consumer_organization_id, left.use_case_id],
        [right.subject_id, right.consumer_organization_id, right.use_case_id],
      )),
    resource_owners: [...(input.resource_owners ?? [])]
      .sort((left, right) => compareTuple([left.resource_id], [right.resource_id]))
      .map((owner) => ({
        resource_id: owner.resource_id,
        organization_id: owner.owner_organization_id,
      })),
    subject_contexts: subjectContexts,
    agent_delegations: agentDelegations,
    execution_grants: executionGrants,
  }
  if (!isCompiledAuthorizationBundle(authorization_bundle)) {
    throw new Error("compiled authorization bundle failed validation")
  }

  return {
    authorization_bundle,
    processor_policy: compileProcessorPolicy(
      input.tenant_id,
      input.revision,
      input.policy_version,
      input.issued_at,
      effectiveExpiresAt,
      projections,
      chains,
    ),
  }
}
