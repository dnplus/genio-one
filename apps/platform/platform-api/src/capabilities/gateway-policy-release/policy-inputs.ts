import { Check } from "typebox/value"

import type { SqlTransaction } from "../../persistence/sql-adapter"
import { PlatformApiError } from "../errors"
import type { ModelEntitlement } from "../entitlements/contract"
import { ModelEntitlementSchema } from "../entitlements/contract"
import type { GatewayProjection } from "../gateway-projection/contract"
import {
  CompiledEnforcementChainSchema,
  type CompiledEnforcementChain,
} from "../enforcement/contract"
import { validateCompiledEnforcementChainSemantics } from "../enforcement/compiler"
import type { ModelRoutingPolicy } from "../model-routing/contract"
import { ModelRoutingPolicySchema } from "../model-routing/contract"
import type { ConnectionModelMapping, PublicModel } from "../models/contract"
import { ConnectionModelMappingSchema, PublicModelSchema } from "../models/contract"
import type { GatewayRoutingConnectionFact, GatewayRoutingPricingFact, GatewayRoutingResourceOwnerRef } from "./routing-compiler"
import type { CompiledAgentDelegation, CompiledExecutionGrant, CompiledSubjectContext, CompiledUsageContext } from "../../../../../../packages/protocol/src/authorization"
import type { UsagePolicyLimits, UsagePolicyRevision, UsagePolicySelectors } from "../usage-governance/contract"

type DatabaseRow = Record<string, unknown>

export interface GatewayPolicyInputSnapshot {
  enforcement_chains: CompiledEnforcementChain[]
  public_models: PublicModel[]
  entitlements: ModelEntitlement[]
  resource_owners: GatewayRoutingResourceOwnerRef[]
  routing_policies: ModelRoutingPolicy[]
  model_mappings: ConnectionModelMapping[]
  connections?: GatewayRoutingConnectionFact[]
  subject_aliases?: Readonly<Record<string, readonly string[]>>
  subject_contexts?: CompiledSubjectContext[]
  agent_delegations?: CompiledAgentDelegation[]
  execution_grants?: CompiledExecutionGrant[]
  usage_policies?: UsagePolicyRevision[]
  usage_contexts?: CompiledUsageContext[]
  pricing?: GatewayRoutingPricingFact[]
}

function enforcementChain(row: DatabaseRow): CompiledEnforcementChain {
  const value = parseJson(row.chain, "GATEWAY_POLICY_INPUT_INVALID")
  if (!Check(CompiledEnforcementChainSchema, value)) {
    throw new PlatformApiError("GATEWAY_POLICY_INPUT_INVALID", 500)
  }
  const chain = value as CompiledEnforcementChain
  try {
    validateCompiledEnforcementChainSemantics(chain)
  } catch {
    throw new PlatformApiError("GATEWAY_POLICY_INPUT_INVALID", 500)
  }
  if (
    chain.tenant_id !== row.tenant_id ||
    chain.resource_id !== row.resource_id ||
    chain.capability_id !== row.capability_id ||
    chain.one_policy_revision !== positiveInteger(row.one_policy_revision)
  ) {
    throw new PlatformApiError("GATEWAY_POLICY_INPUT_MISMATCH", 409)
  }
  return chain
}

/**
 * Freezes the model and entitlement rows used by one aggregate Gateway
 * release. Implementations must use the caller's transaction and return only
 * rows owned by Resources in the supplied closed projection set.
 */
export interface GatewayPolicyInputSource {
  loadForGatewayInTransaction(input: {
    transaction: SqlTransaction
    tenantId: string
    candidateResourceId?: string
    projections: readonly GatewayProjection[]
  }): Promise<GatewayPolicyInputSnapshot>
}

function parseJson(value: unknown, code: string): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new PlatformApiError(code, 500)
  }
}

function object(value: unknown): Record<string, unknown> {
  const parsed = parseJson(value, "GATEWAY_POLICY_INPUT_INVALID")
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PlatformApiError("GATEWAY_POLICY_INPUT_INVALID", 500)
  }
  return parsed as Record<string, unknown>
}

function usagePolicy(row: DatabaseRow): UsagePolicyRevision {
  const selectors = object(row.selectors) as UsagePolicySelectors
  const limits = object(row.limits) as UsagePolicyLimits
  if (!Object.keys(limits).length) throw new PlatformApiError("GATEWAY_POLICY_INPUT_INVALID", 500)
  return {
    tenant_id: requiredString(row.tenant_id),
    usage_policy_id: requiredString(row.usage_policy_id),
    revision: positiveInteger(row.revision),
    owner_organization_id: requiredString(row.owner_organization_id),
    accounting_key_id: requiredString(row.accounting_key_id),
    selectors,
    limits,
    state: requiredString(row.state) as UsagePolicyRevision["state"],
    created_at: timestamp(row.created_at),
  }
}

function pricingFact(row: DatabaseRow): GatewayRoutingPricingFact | null {
  if (
    row.pricing_source == null || row.pricing_version == null ||
    row.input_cost_per_token == null || row.output_cost_per_token == null
  ) return null
  const inputMicros = Number(row.input_cost_per_token) * 1_000_000
  const outputMicros = Number(row.output_cost_per_token) * 1_000_000
  if (!Number.isFinite(inputMicros) || inputMicros < 0 || !Number.isFinite(outputMicros) || outputMicros < 0) {
    throw new PlatformApiError("GATEWAY_POLICY_INPUT_INVALID", 500)
  }
  return {
    mapping_id: requiredString(row.mapping_id),
    currency: "USD",
    input_cost_per_token_micros: inputMicros,
    output_cost_per_token_micros: outputMicros,
    source: requiredString(row.pricing_source),
    version: requiredString(row.pricing_version),
  }
}

function timestamp(value: unknown): number {
  const parsed = typeof value === "bigint" ? Number(value) : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new PlatformApiError("GATEWAY_POLICY_INPUT_INVALID", 500)
  }
  return parsed
}

function positiveInteger(value: unknown): number {
  const parsed = typeof value === "bigint" ? Number(value) : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new PlatformApiError("GATEWAY_POLICY_INPUT_INVALID", 500)
  }
  return parsed
}

function nonNegativeInteger(value: unknown): number {
  const parsed = typeof value === "bigint" ? Number(value) : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new PlatformApiError("GATEWAY_POLICY_INPUT_INVALID", 500)
  }
  return parsed
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || !entry)) {
    throw new PlatformApiError("GATEWAY_POLICY_INPUT_INVALID", 500)
  }
  return [...value]
}

function requiredString(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new PlatformApiError("GATEWAY_POLICY_INPUT_INVALID", 500)
  }
  return value
}

function a2aTargetAgentSubjectId(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  const api = object(value)
  if (api.a2a === null || api.a2a === undefined) return undefined
  return requiredString(object(api.a2a).target_agent_subject_id)
}

function optionalTimestamp(value: unknown): number | null {
  return value === null || value === undefined ? null : timestamp(value)
}

function routingConnection(row: DatabaseRow): GatewayRoutingConnectionFact {
  return {
    tenant_id: requiredString(row.connection_tenant_id ?? row.tenant_id),
    resource_id: requiredString(row.connection_resource_id ?? row.resource_id),
    connection_id: requiredString(row.connection_id),
    configuration_revision: positiveInteger(row.configuration_revision ?? 1),
    ...(row.provider_credential_profile_id === null || row.provider_credential_profile_id === undefined
      ? {}
      : {
          provider_credential_profile_id: requiredString(row.provider_credential_profile_id),
          provider_credential_profile_revision: positiveInteger(row.provider_credential_profile_revision),
          provider_credential_strategy_digest: requiredString(row.provider_credential_strategy_digest),
        }),
    lifecycle: requiredString(row.connection_lifecycle ?? "ENABLED") as GatewayRoutingConnectionFact["lifecycle"],
    verification_state: requiredString(row.verification_state ?? "VERIFIED") as GatewayRoutingConnectionFact["verification_state"],
    health_state: requiredString(row.health_state ?? "HEALTHY") as GatewayRoutingConnectionFact["health_state"],
    health_observed_at: optionalTimestamp(row.health_observed_at ?? row.created_at),
    health_source_revision: row.health_source_revision === null ? null : positiveInteger(row.health_source_revision ?? 1),
    routing_priority: Number(row.routing_priority ?? 0),
    region: row.region === null || row.region === undefined ? null : requiredString(row.region),
    supported_obligations: parseJson(row.supported_obligations ?? [], "GATEWAY_POLICY_INPUT_INVALID") as string[],
    certificate_mode: row.certificate_mode === null || row.certificate_mode === undefined
      ? "SYSTEM_CA"
      : requiredString(row.certificate_mode) as "SYSTEM_CA" | "CUSTOM_CA",
    certificate_not_before: optionalTimestamp(row.certificate_not_before),
    certificate_not_after: optionalTimestamp(row.certificate_not_after),
  }
}

function model(row: DatabaseRow): PublicModel {
  const value = {
    tenant_id: row.tenant_id,
    model_id: row.model_id,
    model_name: row.model_name,
    display_name: row.display_name,
    resource_id: row.resource_id,
    visibility: row.visibility,
    lifecycle: row.lifecycle,
    capabilities: parseJson(row.capabilities, "GATEWAY_POLICY_INPUT_INVALID"),
    created_at: timestamp(row.created_at),
  }
  if (!Check(PublicModelSchema, value)) {
    throw new PlatformApiError("GATEWAY_POLICY_INPUT_INVALID", 500)
  }
  return value
}

function entitlement(row: DatabaseRow): ModelEntitlement {
  const value = {
    tenant_id: row.tenant_id,
    entitlement_id: row.entitlement_id,
    subject_id: row.subject_id,
    client_id: row.client_id,
    resource_id: row.resource_id,
    capability_id: row.capability_id,
    public_model_id: row.public_model_id,
    state: row.state,
    starts_at: timestamp(row.starts_at),
    expires_at: optionalTimestamp(row.expires_at),
    created_at: timestamp(row.created_at),
  }
  if (!Check(ModelEntitlementSchema, value)) {
    throw new PlatformApiError("GATEWAY_POLICY_INPUT_INVALID", 500)
  }
  return value
}

function resourceOwner(row: DatabaseRow): GatewayRoutingResourceOwnerRef {
  return {
    tenant_id: requiredString(row.tenant_id),
    resource_id: requiredString(row.resource_id),
    owner_organization_id: requiredString(row.owner_organization_id),
  }
}

function modelMapping(row: DatabaseRow): ConnectionModelMapping {
  const value = {
    tenant_id: row.tenant_id,
    mapping_id: row.mapping_id,
    public_model_id: row.public_model_id,
    resource_id: row.resource_id,
    connection_id: row.connection_id,
    provider_model: row.provider_model,
    mapping_revision: positiveInteger(row.mapping_revision),
    created_at: timestamp(row.created_at),
  }
  if (!Check(ConnectionModelMappingSchema, value)) {
    throw new PlatformApiError("GATEWAY_POLICY_INPUT_INVALID", 500)
  }
  return value
}

function nullablePositiveInteger(value: unknown): number | null {
  return value === null || value === undefined ? null : positiveInteger(value)
}

function routingPolicy(row: DatabaseRow): ModelRoutingPolicy {
  const value = {
    tenant_id: row.tenant_id,
    routing_policy_id: row.routing_policy_id,
    owner_organization_id: row.owner_organization_id,
    resource_id: row.resource_id,
    capability_id: row.capability_id,
    routing_revision: positiveInteger(row.routing_revision),
    mode: row.mode,
    default_public_model_id: row.default_public_model_id,
    candidate_public_model_ids: parseJson(
      row.candidate_public_model_ids,
      "GATEWAY_POLICY_INPUT_INVALID",
    ),
    session_lease_seconds: nullablePositiveInteger(row.session_lease_seconds),
    context_requirements: parseJson(row.context_requirements ?? [], "GATEWAY_POLICY_INPUT_INVALID"),
    created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at),
  }
  if (!Check(ModelRoutingPolicySchema, value)) {
    throw new PlatformApiError("GATEWAY_POLICY_INPUT_INVALID", 500)
  }
  return value
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
}

function resourceIds(
  tenantId: string,
  projections: readonly GatewayProjection[],
): string[] {
  const result = new Set<string>()
  for (const projection of projections) {
    if (projection.tenant_id !== tenantId || projection.operation !== "APPLY") {
      throw new PlatformApiError("GATEWAY_POLICY_INPUT_MISMATCH", 409)
    }
    result.add(projection.resource_id)
  }
  return [...result].sort(compareUtf8)
}

function projectionScopeKeys(
  projections: readonly GatewayProjection[],
  aiRoutesOnly = true,
): Set<string> {
  return new Set(
    projections
      .filter((projection) =>
        projection.operation === "APPLY" &&
        (!aiRoutesOnly || projection.resources.some((resource) => resource.kind === "AIGatewayRoute")),
      )
      .map((projection) =>
        `${projection.resource_id}\u0000${projection.capability_id}`,
      ),
  )
}

/** Lock the exact model/entitlement input snapshot for one Gateway release. */
export function createPostgresGatewayPolicyInputSource(): GatewayPolicyInputSource {
  return {
    async loadForGatewayInTransaction(input) {
      const resources = resourceIds(input.tenantId, input.projections)
      const resourceSet = new Set(resources)
      if (input.candidateResourceId && !resources.includes(input.candidateResourceId)) {
        throw new PlatformApiError("GATEWAY_POLICY_INPUT_MISMATCH", 409)
      }
      if (resources.length === 0) {
        return {
          enforcement_chains: [],
          public_models: [],
          entitlements: [],
          resource_owners: [],
          routing_policies: [],
          model_mappings: [],
          subject_aliases: {},
          subject_contexts: [],
          agent_delegations: [],
        }
      }
      const resourceRows = await input.transaction.query<DatabaseRow>(
        `select tenant_id, resource_id, owner_organization_id, lifecycle, api_metadata
           from genio_one_resources
          where tenant_id = $1 and resource_id = any($2::text[])
          order by resource_id
          for update`,
        [input.tenantId, resources],
      )
      if (resourceRows.rows.length !== resources.length) {
        throw new PlatformApiError("GATEWAY_POLICY_INPUT_MISMATCH", 409)
      }
      for (const [index, row] of resourceRows.rows.entries()) {
        const resourceId = row.resource_id
        const expectedLifecycles = resourceId === input.candidateResourceId
          ? ["DRAFT", "PUBLISHED"]
          : ["PUBLISHED", "DEPRECATED"]
        if (
          row.tenant_id !== input.tenantId ||
          resourceId !== resources[index] ||
          !expectedLifecycles.includes(String(row.lifecycle))
        ) {
          throw new PlatformApiError("GATEWAY_POLICY_INPUT_MISMATCH", 409)
        }
      }
      const resourceOwners = resourceRows.rows.map(resourceOwner)
      const scopeKeys = projectionScopeKeys(input.projections, false)
      const chainRows = await input.transaction.query<DatabaseRow>(
        `select tenant_id, resource_id, capability_id, one_policy_revision, chain
           from genio_one_enforcement_chain_revisions
          where tenant_id = $1 and resource_id = any($2::text[])
          order by resource_id, capability_id, one_policy_revision desc
          for update`,
        [input.tenantId, resources],
      )
      const latestChains = new Map<string, CompiledEnforcementChain>()
      for (const row of chainRows.rows) {
        const chain = enforcementChain(row)
        const key = `${chain.resource_id}\u0000${chain.capability_id}`
        if (scopeKeys.has(key) && !latestChains.has(key)) latestChains.set(key, chain)
      }
      if (latestChains.size !== scopeKeys.size) {
        throw new PlatformApiError("GATEWAY_ENFORCEMENT_CHAIN_MISSING", 409)
      }
      const enforcementChains = [...latestChains.values()].sort((left, right) => {
        const resourceOrder = compareUtf8(left.resource_id, right.resource_id)
        return resourceOrder !== 0
          ? resourceOrder
          : compareUtf8(left.capability_id, right.capability_id)
      })
      const modelRows = await input.transaction.query<DatabaseRow>(
        `select tenant_id, model_id, model_name, display_name, resource_id,
                visibility, lifecycle, capabilities,
                extract(epoch from created_at)::bigint as created_at
           from genio_one_public_models
          where tenant_id = $1 and resource_id = any($2::text[])
            and visibility = 'PUBLIC' and lifecycle = 'PUBLISHED'
          order by model_id
          for update`,
        [input.tenantId, resources],
      )
      const publicModels = modelRows.rows.map(model)
      const allowedModelIds = new Set(publicModels.map((entry) => entry.model_id))
      const modelIds = publicModels.map((entry) => entry.model_id).sort(compareUtf8)

      const mappingRows = modelIds.length === 0
        ? { rows: [] as DatabaseRow[] }
        : await input.transaction.query<DatabaseRow>(
          `select model_mapping.tenant_id, model_mapping.mapping_id,
                  model_mapping.public_model_id, model_mapping.resource_id,
                  model_mapping.connection_id, model_mapping.provider_model,
                  model_mapping.mapping_revision,
                  resource_connection.tenant_id as connection_tenant_id,
                  resource_connection.resource_id as connection_resource_id,
                  resource_connection.configuration_revision,
                  resource_connection.provider_credential_profile_id,
                  resource_connection.provider_credential_profile_revision,
                  resource_connection.provider_credential_strategy_digest,
                  resource_connection.lifecycle as connection_lifecycle,
                  resource_connection.verification_state,
                  resource_connection.health_state,
                  case when resource_connection.health_observed_at is null then null
                       else extract(epoch from resource_connection.health_observed_at)::bigint end as health_observed_at,
                  resource_connection.health_source_revision,
                  resource_connection.routing_priority,
                  resource_connection.region,
                  resource_connection.supported_obligations,
                  resource_connection.certificate_mode,
                  case when resource_connection.certificate_not_before is null then null
                       else extract(epoch from resource_connection.certificate_not_before)::bigint end as certificate_not_before,
                  case when resource_connection.certificate_not_after is null then null
                       else extract(epoch from resource_connection.certificate_not_after)::bigint end as certificate_not_after,
                  case when price.input_cost_per_token is null then null else 'LITELLM' end as pricing_source,
                  price_version.source_version as pricing_version,
                  price.input_cost_per_token,
                  price.output_cost_per_token,
                  extract(epoch from model_mapping.created_at)::bigint as created_at
             from genio_one_connection_model_mappings model_mapping
             join genio_one_resource_connections resource_connection
               on resource_connection.tenant_id = model_mapping.tenant_id
              and resource_connection.resource_id = model_mapping.resource_id
              and resource_connection.connection_id = model_mapping.connection_id
            left join genio_one_price_catalog_versions price_version
              on price_version.source = 'LITELLM'
             and price_version.status = 'CURRENT'
            left join lateral (
              select candidate.input_cost_per_token, candidate.output_cost_per_token
                from genio_one_model_price_catalog candidate
               where candidate.source = price_version.source
                 and candidate.source_version = price_version.source_version
                 and candidate.provider_id = upper(resource_connection.provider_type)
                 and (
                   lower(candidate.catalog_model_key) = lower(model_mapping.provider_model)
                   or lower(candidate.provider_model_id) = lower(model_mapping.provider_model)
                   or (
                     length(model_mapping.provider_model) > 7
                     and right(lower(model_mapping.provider_model), 7) = ':latest'
                     and lower(candidate.provider_model_id) = lower(left(model_mapping.provider_model, length(model_mapping.provider_model) - 7))
                   )
                 )
               order by case
                          when lower(candidate.catalog_model_key) = lower(model_mapping.provider_model) then 0
                          when lower(candidate.provider_model_id) = lower(model_mapping.provider_model) then 1
                          else 2
                        end,
                        length(candidate.catalog_model_key), candidate.catalog_model_key
               limit 1
            ) price on true
            where model_mapping.tenant_id = $1
              and model_mapping.public_model_id = any($2::text[])
              and resource_connection.lifecycle = 'ENABLED'
              and resource_connection.verification_state = 'VERIFIED'
            order by model_mapping.mapping_id
            for update of model_mapping, resource_connection`,
          [input.tenantId, modelIds],
        )
      const modelMappings = mappingRows.rows.map(modelMapping)
      const pricing = mappingRows.rows.flatMap((row) => {
        const value = pricingFact(row)
        return value ? [value] : []
      })
      const routingConnections = [...new Map(mappingRows.rows.map((row) => {
        const connection = routingConnection(row)
        return [connection.connection_id, connection]
      })).values()]
      if (modelMappings.some((entry) => !allowedModelIds.has(entry.public_model_id))) {
        throw new PlatformApiError("GATEWAY_POLICY_INPUT_MISMATCH", 409)
      }

      const routingScopeKeys = projectionScopeKeys(input.projections)
      const policyRows = await input.transaction.query<DatabaseRow>(
        `select tenant_id, routing_policy_id, owner_organization_id,
                resource_id, capability_id, routing_revision, mode,
                default_public_model_id, candidate_public_model_ids,
                session_lease_seconds, context_requirements,
                extract(epoch from created_at)::bigint as created_at,
                extract(epoch from updated_at)::bigint as updated_at
           from genio_one_model_routing_policies
          where tenant_id = $1 and resource_id = any($2::text[])
          order by resource_id, capability_id, routing_revision desc
          for update`,
        [input.tenantId, resources],
      )
      const latestPolicies = new Map<string, ModelRoutingPolicy>()
      for (const row of policyRows.rows) {
        const policy = routingPolicy(row)
        const key = `${policy.resource_id}\u0000${policy.capability_id}`
        if (routingScopeKeys.has(key) && !latestPolicies.has(key)) {
          latestPolicies.set(key, policy)
        }
      }
      if (latestPolicies.size !== routingScopeKeys.size) {
        throw new PlatformApiError("GATEWAY_ROUTING_POLICY_MISSING", 409)
      }
      const routingPolicies = [...latestPolicies.values()].sort((left, right) => {
        const resourceOrder = compareUtf8(left.resource_id, right.resource_id)
        return resourceOrder !== 0
          ? resourceOrder
          : compareUtf8(left.capability_id, right.capability_id)
      })

      const entitlementRows = await input.transaction.query<DatabaseRow>(
          `select entitlement.tenant_id, entitlement.entitlement_id,
                  entitlement.subject_id, entitlement.client_id,
                  entitlement.resource_id, entitlement.capability_id,
                  entitlement.public_model_id, entitlement.state,
                  extract(epoch from entitlement.starts_at)::bigint as starts_at,
                  case when entitlement.expires_at is null then null
                       else extract(epoch from entitlement.expires_at)::bigint end as expires_at,
                  extract(epoch from entitlement.created_at)::bigint as created_at
             from genio_one_model_entitlements entitlement
            where entitlement.tenant_id = $1
              and entitlement.resource_id = any($2::text[])
            order by entitlement.entitlement_id
            for update of entitlement`,
          [input.tenantId, resources],
        )
      const entitlements = entitlementRows.rows.map(entitlement)
      if (entitlements.some((entry) =>
        entry.public_model_id !== null && !allowedModelIds.has(entry.public_model_id),
      )) {
        throw new PlatformApiError("GATEWAY_POLICY_INPUT_MISMATCH", 409)
      }
      const subjectIds = [...new Set([
        ...entitlements
          .map((entry) => entry.subject_id)
          .filter((value): value is string => typeof value === "string"),
        ...resourceRows.rows.flatMap((row) => {
          const target = a2aTargetAgentSubjectId(row.api_metadata)
          return target ? [target] : []
        }),
      ])]
        .sort(compareUtf8)
      const aliasRows = subjectIds.length === 0
        ? { rows: [] as DatabaseRow[] }
        : await input.transaction.query<DatabaseRow>(
          `select subject_id, external_subject_id
             from genio_one_external_identity_bindings
            where tenant_id = $1 and subject_id = any($2::text[])
            order by subject_id, external_subject_id
            for update`,
          [input.tenantId, subjectIds],
        )
      const subjectAliases: Record<string, string[]> = {}
      for (const row of aliasRows.rows) {
        const subjectId = requiredString(row.subject_id)
        const externalSubjectId = requiredString(row.external_subject_id)
        const aliases = subjectAliases[subjectId] ??= []
        if (!aliases.includes(externalSubjectId)) aliases.push(externalSubjectId)
      }
      const subjectRows = subjectIds.length === 0
        ? { rows: [] as DatabaseRow[] }
        : await input.transaction.query<DatabaseRow>(
          `select subject_id, kind
             from genio_one_subjects
            where tenant_id = $1 and subject_id = any($2::text[])
            order by subject_id
            for update`,
          [input.tenantId, subjectIds],
        )
      if (subjectRows.rows.length !== subjectIds.length) {
        throw new PlatformApiError("GATEWAY_POLICY_SUBJECT_CONTEXT_MISSING", 409)
      }
      const subjectContexts = subjectRows.rows.map((row): CompiledSubjectContext => {
        const kind = requiredString(row.kind)
        if (kind !== "PERSON" && kind !== "APPLICATION" && kind !== "AGENT") {
          throw new PlatformApiError("GATEWAY_POLICY_INPUT_INVALID", 500)
        }
        return { subject_id: requiredString(row.subject_id), kind }
      })
      const delegationRows = await input.transaction.query<DatabaseRow>(
        `with locked as materialized (
           select delegation_id, revision, principal_subject_id, agent_subject_id,
                  resource_id, capability_ids, acting_client_ids, starts_at,
                  expires_at, revocation_generation, state
             from genio_one_agent_delegation_revisions
            where tenant_id = $1 and resource_id = any($2::text[])
            for update
         )
         select distinct on (delegation_id)
                delegation_id, revision, principal_subject_id, agent_subject_id,
                resource_id, capability_ids, acting_client_ids, starts_at,
                expires_at, revocation_generation, state
           from locked
          order by delegation_id, revision desc`,
        [input.tenantId, resources],
      )
      const agentDelegations = delegationRows.rows.map((row): CompiledAgentDelegation => {
        const state = requiredString(row.state)
        if (state !== "ACTIVE" && state !== "REVOKED") throw new PlatformApiError("GATEWAY_POLICY_INPUT_INVALID", 500)
        const capabilityIds = stringArray(row.capability_ids)
        const actingClientIds = stringArray(row.acting_client_ids)
        return {
          delegation_id: requiredString(row.delegation_id),
          revision: positiveInteger(row.revision),
          principal_subject_id: requiredString(row.principal_subject_id),
          agent_subject_id: requiredString(row.agent_subject_id),
          resource_id: requiredString(row.resource_id),
          capability_ids: capabilityIds,
          acting_client_ids: actingClientIds,
          starts_at: nonNegativeInteger(row.starts_at),
          expires_at: positiveInteger(row.expires_at),
          revocation_generation: nonNegativeInteger(row.revocation_generation),
          state,
        }
      })
      const executionGrantRows = await input.transaction.query<DatabaseRow>(
        `select execution_grant_id, subject_id, acting_client_id, resource_id,
                capability_id, action_digest, issued_at, expires_at, issued_by_subject_id
           from genio_one_execution_grants
          where tenant_id = $1 and resource_id = any($2::text[])
          order by execution_grant_id
          for update`,
        [input.tenantId, resources],
      )
      const executionGrants = executionGrantRows.rows.map((row): CompiledExecutionGrant => ({
        execution_grant_id: requiredString(row.execution_grant_id),
        subject_id: requiredString(row.subject_id),
        acting_client_id: requiredString(row.acting_client_id),
        resource_id: requiredString(row.resource_id),
        capability_id: requiredString(row.capability_id),
        action_digest: requiredString(row.action_digest),
        issued_at: nonNegativeInteger(row.issued_at),
        expires_at: positiveInteger(row.expires_at),
        issued_by_subject_id: requiredString(row.issued_by_subject_id),
      }))
      const usagePolicyRows = await input.transaction.query<DatabaseRow>(
        `select tenant_id, usage_policy_id, revision, owner_organization_id,
                accounting_key_id, selectors, limits, state,
                extract(epoch from created_at)::bigint as created_at
           from genio_one_usage_policy_revisions
          where tenant_id = $1 and state = 'ACTIVE'
          order by usage_policy_id, revision desc
          for update`,
        [input.tenantId],
      )
      const usagePolicyById = new Map<string, UsagePolicyRevision>()
      for (const row of usagePolicyRows.rows) {
        const policy = usagePolicy(row)
        if (usagePolicyById.has(policy.usage_policy_id)) continue
        if (policy.selectors.resource_id && !resourceSet.has(policy.selectors.resource_id)) continue
        usagePolicyById.set(policy.usage_policy_id, policy)
      }
      const usageContextRows = subjectIds.length === 0
        ? { rows: [] as DatabaseRow[] }
        : await input.transaction.query<DatabaseRow>(
          `select membership.subject_id,
                  membership.organization_id as consumer_organization_id,
                  use_case.use_case_id,
                  use_case.risk_level
             from genio_one_organization_memberships membership
             join genio_one_use_cases use_case
               on use_case.tenant_id = membership.tenant_id
              and use_case.organization_id = membership.organization_id
              and use_case.state = 'ACTIVE'
            where membership.tenant_id = $1
              and membership.subject_id = any($2::text[])
            order by membership.subject_id, membership.organization_id, use_case.use_case_id
            for update of membership, use_case`,
          [input.tenantId, subjectIds],
        )
      const usageContexts = usageContextRows.rows.map((row): CompiledUsageContext => ({
        subject_id: requiredString(row.subject_id),
        consumer_organization_id: requiredString(row.consumer_organization_id),
        use_case_id: requiredString(row.use_case_id),
        risk_level: requiredString(row.risk_level) as "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
      }))
      return {
        enforcement_chains: enforcementChains,
        public_models: publicModels,
        entitlements,
        resource_owners: resourceOwners,
        routing_policies: routingPolicies,
        model_mappings: modelMappings,
        connections: routingConnections,
        subject_aliases: subjectAliases,
        subject_contexts: subjectContexts,
        agent_delegations: agentDelegations,
        ...(executionGrants.length > 0 ? { execution_grants: executionGrants } : {}),
        usage_policies: [...usagePolicyById.values()],
        usage_contexts: usageContexts,
        pricing,
      }
    },
  }
}
