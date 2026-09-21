import { Check } from "typebox/value"

import {
  gatewayRoutingCandidateSetDigest,
  validateGatewayRoutingArtifact,
  type GatewayRoutingArtifact,
  type GatewayRoutingConnectionMapping,
  type GatewayRoutingPublicModelCandidate,
  type GatewayRoutingScope,
} from "../../../../../../runtimes/gateway/services/shared/gateway-routing-artifact"
import type { ModelRoutingPolicy } from "../model-routing/contract"
import { compareUtf8 } from "@genioone/protocol/canonical"
import {
  ModelRoutingPolicySchema,
} from "../model-routing/contract"
import type {
  ConnectionModelMapping,
  PublicModel,
} from "../models/contract"
import {
  ConnectionModelMappingSchema,
  PublicModelSchema,
} from "../models/contract"

/**
 * The routing compiler deliberately consumes a small, closed projection
 * summary rather than GatewayProjection's native Kubernetes maps.  Native
 * resources are compiled by the projection renderer; this module only needs
 * the identity and the One Policy revision of an already admitted AI route.
 */
export interface GatewayRoutingApplyProjection {
  operation: "APPLY"
  tenant_id: string
  resource_id: string
  capability_id: string
  one_policy_revision: number
  required_obligation_kinds: string[]
  eligible_connection_ids?: string[]
}

/** The Resource ownership fact needed by the runtime routing artifact. */
export interface GatewayRoutingResourceOwnerRef {
  tenant_id: string
  resource_id: string
  owner_organization_id: string
}

export interface GatewayRoutingConnectionFact {
  tenant_id: string
  resource_id: string
  connection_id: string
  configuration_revision: number
  provider_credential_profile_id?: string
  provider_credential_profile_revision?: number
  provider_credential_strategy_digest?: string
  lifecycle: "DRAFT" | "ENABLED" | "DISABLED" | "REVOKE_PENDING" | "REVOKED"
  verification_state: "UNVERIFIED" | "VERIFIED" | "FAILED"
  health_state: "UNKNOWN" | "HEALTHY" | "DEGRADED" | "UNAVAILABLE"
  health_observed_at: number | null
  health_source_revision: number | null
  routing_priority: number
  region: string | null
  supported_obligations: string[]
  certificate_mode?: "SYSTEM_CA" | "CUSTOM_CA"
  certificate_not_before?: number | null
  certificate_not_after?: number | null
}

export interface GatewayRoutingPricingFact {
  mapping_id: string
  currency: string
  input_cost_per_token_micros: number
  output_cost_per_token_micros: number
  source: string
  version: string
}

export interface GatewayRoutingArtifactCompilerInput {
  tenant_id: string
  gateway_id: string
  revision: string
  policy_version: string
  issued_at: number
  expires_at: number
  /** Closed APPLY summaries; no native resource/spec maps are accepted. */
  projections: readonly GatewayRoutingApplyProjection[]
  resource_owners: readonly GatewayRoutingResourceOwnerRef[]
  /** Exactly one effective immutable revision is required per projected route. */
  routing_policies: readonly ModelRoutingPolicy[]
  public_models: readonly PublicModel[]
  model_mappings: readonly ConnectionModelMapping[]
  connections?: readonly GatewayRoutingConnectionFact[]
  pricing?: readonly GatewayRoutingPricingFact[]
}

const APPLY_PROJECTION_KEYS = [
  "operation",
  "tenant_id",
  "resource_id",
  "capability_id",
  "one_policy_revision",
  "required_obligation_kinds",
] as const

const RESOURCE_OWNER_KEYS = [
  "tenant_id",
  "resource_id",
  "owner_organization_id",
] as const

const PUBLIC_MODEL_KEYS = [
  "tenant_id",
  "model_id",
  "model_name",
  "display_name",
  "resource_id",
  "visibility",
  "lifecycle",
  "capabilities",
  "created_at",
] as const

const MODEL_MAPPING_KEYS = [
  "tenant_id",
  "mapping_id",
  "public_model_id",
  "resource_id",
  "connection_id",
  "provider_model",
  "mapping_revision",
  "created_at",
] as const

const MODEL_ROUTING_POLICY_KEYS = [
  "tenant_id",
  "routing_policy_id",
  "owner_organization_id",
  "resource_id",
  "capability_id",
  "routing_revision",
  "mode",
  "default_public_model_id",
  "candidate_public_model_ids",
  "session_lease_seconds",
  "created_at",
  "updated_at",
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  optionalKeys: readonly string[] = [],
): boolean {
  const actual = Object.keys(value)
  const allowed = new Set([...keys, ...optionalKeys])
  return keys.every((key) => Object.hasOwn(value, key)) && actual.every((key) => allowed.has(key))
}

function identifier(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} is invalid`)
  }
}

function positiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive safe integer`)
  }
}

function timestamp(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
}

function compareTuple(left: readonly string[], right: readonly string[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference = compareUtf8(left[index]!, right[index]!)
    if (difference !== 0) return difference
  }
  return left.length - right.length
}

function routeKey(resourceId: string, capabilityId: string): string {
  return `${resourceId}\u0000${capabilityId}`
}

function assertArray(value: unknown, label: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
}

function assertClosedProjection(
  value: unknown,
  tenantId: string,
  index: number,
): asserts value is GatewayRoutingApplyProjection {
  if (!isRecord(value) || !hasExactKeys(value, APPLY_PROJECTION_KEYS, ["eligible_connection_ids"])) {
    throw new Error(`projections[${index}] must be a closed APPLY projection`)
  }
  if (value.operation !== "APPLY") {
    throw new Error(`projections[${index}] must be an APPLY projection`)
  }
  identifier(value.tenant_id, `projections[${index}].tenant_id`)
  if (value.tenant_id !== tenantId) {
    throw new Error(`projections[${index}] tenant does not match compiler tenant`)
  }
  identifier(value.resource_id, `projections[${index}].resource_id`)
  identifier(value.capability_id, `projections[${index}].capability_id`)
  positiveInteger(value.one_policy_revision, `projections[${index}].one_policy_revision`)
  if (!Array.isArray(value.required_obligation_kinds) || value.required_obligation_kinds.some((item) => typeof item !== "string" || !item)) {
    throw new Error(`projections[${index}].required_obligation_kinds is invalid`)
  }
  if (value.eligible_connection_ids !== undefined) {
    if (!Array.isArray(value.eligible_connection_ids) || value.eligible_connection_ids.length === 0) {
      throw new Error(`projections[${index}].eligible_connection_ids is invalid`)
    }
    const connectionIds = new Set<string>()
    value.eligible_connection_ids.forEach((connectionId, connectionIndex) => {
      identifier(connectionId, `projections[${index}].eligible_connection_ids[${connectionIndex}]`)
      if (connectionIds.has(connectionId)) {
        throw new Error(`projections[${index}].eligible_connection_ids contains duplicates`)
      }
      connectionIds.add(connectionId)
    })
  }
}

function assertOwnerRef(
  value: unknown,
  tenantId: string,
  index: number,
): asserts value is GatewayRoutingResourceOwnerRef {
  if (!isRecord(value) || !hasExactKeys(value, RESOURCE_OWNER_KEYS)) {
    throw new Error(`resource_owners[${index}] must be a closed Resource owner reference`)
  }
  identifier(value.tenant_id, `resource_owners[${index}].tenant_id`)
  if (value.tenant_id !== tenantId) {
    throw new Error(`resource_owners[${index}] tenant does not match compiler tenant`)
  }
  identifier(value.resource_id, `resource_owners[${index}].resource_id`)
  identifier(
    value.owner_organization_id,
    `resource_owners[${index}].owner_organization_id`,
  )
}

function assertPublicModel(
  value: unknown,
  tenantId: string,
  index: number,
): asserts value is PublicModel {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, PUBLIC_MODEL_KEYS) ||
    !Check(PublicModelSchema, value)
  ) {
    throw new Error(`public_models[${index}] is invalid or contains unexpected fields`)
  }
  identifier(value.tenant_id, `public_models[${index}].tenant_id`)
  if (value.tenant_id !== tenantId) {
    throw new Error(`public_models[${index}] tenant does not match compiler tenant`)
  }
  identifier(value.model_id, `public_models[${index}].model_id`)
  identifier(value.model_name, `public_models[${index}].model_name`)
  identifier(value.resource_id, `public_models[${index}].resource_id`)
  identifier(value.display_name, `public_models[${index}].display_name`)
  if (value.visibility !== "PUBLIC") {
    throw new Error(`public_models[${index}] must be PUBLIC for a Gateway route`)
  }
  if (value.lifecycle !== "PUBLISHED") {
    throw new Error(`public_models[${index}] must be PUBLISHED for a Gateway route`)
  }
}

function assertModelMapping(
  value: unknown,
  tenantId: string,
  index: number,
): asserts value is ConnectionModelMapping {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, MODEL_MAPPING_KEYS) ||
    !Check(ConnectionModelMappingSchema, value)
  ) {
    throw new Error(`model_mappings[${index}] is invalid or contains unexpected fields`)
  }
  identifier(value.tenant_id, `model_mappings[${index}].tenant_id`)
  if (value.tenant_id !== tenantId) {
    throw new Error(`model_mappings[${index}] tenant does not match compiler tenant`)
  }
  identifier(value.mapping_id, `model_mappings[${index}].mapping_id`)
  identifier(value.public_model_id, `model_mappings[${index}].public_model_id`)
  identifier(value.resource_id, `model_mappings[${index}].resource_id`)
  identifier(value.connection_id, `model_mappings[${index}].connection_id`)
  identifier(value.provider_model, `model_mappings[${index}].provider_model`)
}

function assertRoutingPolicy(
  value: unknown,
  tenantId: string,
  index: number,
): asserts value is ModelRoutingPolicy {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, MODEL_ROUTING_POLICY_KEYS, ["context_requirements"]) ||
    !Check(ModelRoutingPolicySchema, value)
  ) {
    throw new Error(`routing_policies[${index}] is invalid or contains unexpected fields`)
  }
  identifier(value.tenant_id, `routing_policies[${index}].tenant_id`)
  if (value.tenant_id !== tenantId) {
    throw new Error(`routing_policies[${index}] tenant does not match compiler tenant`)
  }
  identifier(value.routing_policy_id, `routing_policies[${index}].routing_policy_id`)
  identifier(
    value.owner_organization_id,
    `routing_policies[${index}].owner_organization_id`,
  )
  identifier(value.resource_id, `routing_policies[${index}].resource_id`)
  identifier(value.capability_id, `routing_policies[${index}].capability_id`)
  identifier(
    value.default_public_model_id,
    `routing_policies[${index}].default_public_model_id`,
  )
  positiveInteger(value.routing_revision, `routing_policies[${index}].routing_revision`)
  timestamp(value.created_at, `routing_policies[${index}].created_at`)
  timestamp(value.updated_at, `routing_policies[${index}].updated_at`)
  if (value.candidate_public_model_ids.length === 0) {
    throw new Error(`routing_policies[${index}] must contain a candidate Public Model`)
  }
  value.candidate_public_model_ids.forEach((modelId, candidateIndex) =>
    identifier(
      modelId,
      `routing_policies[${index}].candidate_public_model_ids[${candidateIndex}]`,
    ),
  )
  if (
    value.mode === "SESSION_LEASE" &&
    (value.session_lease_seconds === null || value.session_lease_seconds < 1)
  ) {
    throw new Error(`routing_policies[${index}] SESSION_LEASE requires a positive TTL`)
  }
  if (value.mode === "DETERMINISTIC" && value.session_lease_seconds !== null) {
    throw new Error(`routing_policies[${index}] DETERMINISTIC cannot define a session TTL`)
  }
}

function buildCandidate(
  policy: ModelRoutingPolicy,
  publicModel: PublicModel,
  mappings: readonly ConnectionModelMapping[],
  connectionsById: ReadonlyMap<string, GatewayRoutingConnectionFact>,
  issuedAt: number,
  requiredObligations: readonly string[],
  pricingByMappingId: ReadonlyMap<string, GatewayRoutingPricingFact>,
  eligibleConnectionIds: ReadonlySet<string> | undefined,
): GatewayRoutingPublicModelCandidate {
  const eligibleMappings = mappings.filter((mapping) => {
    const connection = connectionsById.get(mapping.connection_id)
    const certificateUsable = connection?.certificate_mode !== "CUSTOM_CA" || (
      connection.certificate_not_before !== null &&
      connection.certificate_not_before !== undefined &&
      connection.certificate_not_after !== null &&
      connection.certificate_not_after !== undefined &&
      issuedAt >= connection.certificate_not_before &&
      issuedAt < connection.certificate_not_after
    )
    return connection !== undefined &&
      connection.resource_id === mapping.resource_id &&
      (eligibleConnectionIds === undefined || eligibleConnectionIds.has(mapping.connection_id)) &&
      certificateUsable &&
      connection.lifecycle === "ENABLED" &&
      connection.verification_state === "VERIFIED" &&
      connection.health_state === "HEALTHY" &&
      connection.health_observed_at !== null &&
      connection.health_source_revision !== null &&
      connection.health_observed_at <= issuedAt &&
      issuedAt - connection.health_observed_at <= 300 &&
      requiredObligations.every((obligation) => connection.supported_obligations.includes(obligation))
  })
  const orderedMappings = [...eligibleMappings].sort((left, right) => {
    const leftConnection = connectionsById.get(left.connection_id)!
    const rightConnection = connectionsById.get(right.connection_id)!
    return leftConnection.routing_priority - rightConnection.routing_priority ||
      compareUtf8(left.mapping_id, right.mapping_id)
  })
  const artifactMappings: GatewayRoutingConnectionMapping[] = orderedMappings.map(
    (mapping, index) => {
      const connection = connectionsById.get(mapping.connection_id)!
      const pricingFact = pricingByMappingId.get(mapping.mapping_id)
      const pricing = pricingFact ? {
        currency: pricingFact.currency,
        input_cost_per_token_micros: pricingFact.input_cost_per_token_micros,
        output_cost_per_token_micros: pricingFact.output_cost_per_token_micros,
        source: pricingFact.source,
        version: pricingFact.version,
      } : undefined
      return {
        order: index + 1,
        mapping_id: mapping.mapping_id,
        resource_id: mapping.resource_id,
        connection_id: mapping.connection_id,
        provider_model: mapping.provider_model,
        mapping_revision: mapping.mapping_revision,
        connection_configuration_revision: connection.configuration_revision,
        ...(connection.provider_credential_profile_id ? {
          provider_credential_profile_id: connection.provider_credential_profile_id,
          provider_credential_profile_revision: connection.provider_credential_profile_revision!,
          provider_credential_strategy_digest: connection.provider_credential_strategy_digest!,
        } : {}),
        priority: connection.routing_priority,
        region: connection.region,
        supported_obligations: connection.supported_obligations,
        health_observed_at: connection.health_observed_at!,
        health_source_revision: connection.health_source_revision!,
        ...(pricing ? { pricing } : {}),
      }
    },
  )
  return {
    order: policy.candidate_public_model_ids.indexOf(publicModel.model_id) + 1,
    public_model_id: publicModel.model_id,
    public_model_name: publicModel.model_name,
    mappings: artifactMappings,
  }
}

function compileScope(
  projection: GatewayRoutingApplyProjection,
  owner: GatewayRoutingResourceOwnerRef,
  policy: ModelRoutingPolicy,
  modelsById: ReadonlyMap<string, PublicModel>,
  mappingsByModelId: ReadonlyMap<string, readonly ConnectionModelMapping[]>,
  connectionsById: ReadonlyMap<string, GatewayRoutingConnectionFact>,
  pricingByMappingId: ReadonlyMap<string, GatewayRoutingPricingFact>,
  issuedAt: number,
): GatewayRoutingScope {
  if (policy.resource_id !== projection.resource_id || policy.capability_id !== projection.capability_id) {
    throw new Error(
      `routing policy ${policy.routing_policy_id} does not match projected Resource/Capability`,
    )
  }
  if (policy.owner_organization_id !== owner.owner_organization_id) {
    throw new Error(
      `routing policy ${policy.routing_policy_id} owner does not match Resource ${projection.resource_id}`,
    )
  }
  if (policy.default_public_model_id !== policy.candidate_public_model_ids[0]) {
    throw new Error(
      `routing policy ${policy.routing_policy_id} default must be the first ordered candidate`,
    )
  }

  const candidates = policy.candidate_public_model_ids.map((modelId, index) => {
    const model = modelsById.get(modelId)
    if (!model) {
      throw new Error(
        `routing policy ${policy.routing_policy_id} references unknown Public Model ${modelId}`,
      )
    }
    if (model.resource_id !== projection.resource_id) {
      throw new Error(
        `Public Model ${modelId} is owned by Resource ${model.resource_id}, not ${projection.resource_id}`,
      )
    }
    const modelMappings = mappingsByModelId.get(modelId) ?? []
    if (modelMappings.length === 0) {
      throw new Error(`Public Model ${modelId} has no ready Connection mapping`)
    }
    const candidate = buildCandidate(
      policy,
      model,
      modelMappings,
      connectionsById,
      issuedAt,
      projection.required_obligation_kinds,
      pricingByMappingId,
      projection.eligible_connection_ids ? new Set(projection.eligible_connection_ids) : undefined,
    )
    if (candidate.order !== index + 1) {
      throw new Error(`routing policy ${policy.routing_policy_id} candidate order is invalid`)
    }
    return candidate
  })

  const scope: GatewayRoutingScope = {
    owner_organization_id: owner.owner_organization_id,
    resource_id: projection.resource_id,
    capability_id: projection.capability_id,
    routing_policy_id: policy.routing_policy_id,
    routing_revision: policy.routing_revision,
    one_policy_revision: projection.one_policy_revision,
    route_mode: policy.mode,
    default_public_model_id: policy.default_public_model_id,
    candidate_set_digest: gatewayRoutingCandidateSetDigest(candidates),
    required_obligation_kinds: [...projection.required_obligation_kinds].sort(compareUtf8),
    context_requirements: (policy.context_requirements ?? []).map((requirement) => ({
      ...requirement,
      required_obligation_kinds: [...requirement.required_obligation_kinds].sort(compareUtf8),
    })),
    retry_policy: {
      per_priority_max_attempts: 1,
      max_attempts: candidates.reduce((total, candidate) => total + candidate.mappings.length, 0),
      retry_on: ["CONNECT_FAILURE", "RESET_BEFORE_RESPONSE"],
      http_5xx: "IDEMPOTENT_ONLY",
      streaming: "BEFORE_FIRST_TOKEN_ONLY",
    },
    candidates,
  }
  if (policy.mode === "SESSION_LEASE") {
    if (policy.session_lease_seconds === null) {
      throw new Error(`routing policy ${policy.routing_policy_id} has no session lease TTL`)
    }
    scope.session_lease = {
      ttl_seconds: policy.session_lease_seconds,
      key_scope: "TENANT_SUBJECT_CLIENT_RESOURCE_CAPABILITY_SESSION",
    }
  }
  return scope
}

/**
 * Compile the closed, frozen CP routing view into the runtime-neutral
 * GatewayRoutingArtifact. The function has no repository or runtime side
 * effects; all ownership and membership checks happen before the artifact is
 * returned and then the shared contract performs its final structural check.
 */
export function compileGatewayRoutingArtifact(
  input: GatewayRoutingArtifactCompilerInput,
): GatewayRoutingArtifact {
  identifier(input.tenant_id, "tenant_id")
  identifier(input.gateway_id, "gateway_id")
  identifier(input.revision, "revision")
  identifier(input.policy_version, "policy_version")
  timestamp(input.issued_at, "issued_at")
  timestamp(input.expires_at, "expires_at")
  if (input.expires_at <= input.issued_at) {
    throw new Error("expires_at must be after issued_at")
  }

  assertArray(input.projections, "projections")
  assertArray(input.resource_owners, "resource_owners")
  assertArray(input.routing_policies, "routing_policies")
  assertArray(input.public_models, "public_models")
  assertArray(input.model_mappings, "model_mappings")
  if (input.connections !== undefined) assertArray(input.connections, "connections")
  if (input.pricing !== undefined) assertArray(input.pricing, "pricing")

  const projections: GatewayRoutingApplyProjection[] = []
  const projectionKeys = new Set<string>()
  for (const [index, projection] of input.projections.entries()) {
    assertClosedProjection(projection, input.tenant_id, index)
    const key = routeKey(projection.resource_id, projection.capability_id)
    if (projectionKeys.has(key)) {
      throw new Error(`projections contain duplicate Resource/Capability: ${key}`)
    }
    projectionKeys.add(key)
    projections.push(projection)
  }

  const ownersByResource = new Map<string, GatewayRoutingResourceOwnerRef>()
  for (const [index, owner] of input.resource_owners.entries()) {
    assertOwnerRef(owner, input.tenant_id, index)
    if (ownersByResource.has(owner.resource_id)) {
      throw new Error(`resource_owners contain duplicate Resource: ${owner.resource_id}`)
    }
    ownersByResource.set(owner.resource_id, owner)
  }

  const modelsById = new Map<string, PublicModel>()
  const modelNames = new Set<string>()
  for (const [index, model] of input.public_models.entries()) {
    assertPublicModel(model, input.tenant_id, index)
    if (modelsById.has(model.model_id)) {
      throw new Error(`public_models contain duplicate model_id: ${model.model_id}`)
    }
    if (modelNames.has(model.model_name)) {
      throw new Error(`public_models contain duplicate model_name: ${model.model_name}`)
    }
    modelsById.set(model.model_id, model)
    modelNames.add(model.model_name)
  }

  const mappingsByModelId = new Map<string, ConnectionModelMapping[]>()
  const connectionsById = new Map<string, GatewayRoutingConnectionFact>()
  const connectionFacts: readonly GatewayRoutingConnectionFact[] = input.connections ?? input.model_mappings.map((mapping) => ({
    tenant_id: input.tenant_id,
    resource_id: mapping.resource_id,
    connection_id: mapping.connection_id,
    configuration_revision: 1,
    lifecycle: "ENABLED" as const,
    verification_state: "VERIFIED" as const,
    health_state: "HEALTHY" as const,
    health_observed_at: input.issued_at,
    health_source_revision: 1,
    routing_priority: 0,
    region: null,
    supported_obligations: [],
    certificate_mode: "SYSTEM_CA",
    certificate_not_before: null,
    certificate_not_after: null,
  }))
  for (const [index, connection] of connectionFacts.entries()) {
    if (!isRecord(connection)) throw new Error(`connections[${index}] is invalid`)
    identifier(connection.tenant_id, `connections[${index}].tenant_id`)
    identifier(connection.resource_id, `connections[${index}].resource_id`)
    identifier(connection.connection_id, `connections[${index}].connection_id`)
    if (connection.tenant_id !== input.tenant_id) throw new Error(`connections[${index}] tenant does not match compiler tenant`)
    positiveInteger(connection.configuration_revision, `connections[${index}].configuration_revision`)
    const profileFields = [
      connection.provider_credential_profile_id,
      connection.provider_credential_profile_revision,
      connection.provider_credential_strategy_digest,
    ]
    if (profileFields.some((value) => value !== undefined) && profileFields.some((value) => value === undefined)) {
      throw new Error(`connections[${index}] provider credential binding must be all-or-none`)
    }
    if (connection.provider_credential_profile_id !== undefined) {
      identifier(connection.provider_credential_profile_id, `connections[${index}].provider_credential_profile_id`)
      positiveInteger(connection.provider_credential_profile_revision, `connections[${index}].provider_credential_profile_revision`)
      if (!/^[a-f0-9]{64}$/.test(connection.provider_credential_strategy_digest!)) {
        throw new Error(`connections[${index}].provider_credential_strategy_digest is invalid`)
      }
    }
    if (!Number.isSafeInteger(connection.routing_priority) || connection.routing_priority < 0 || connection.routing_priority > 1000) {
      throw new Error(`connections[${index}].routing_priority is invalid`)
    }
    if (connection.certificate_mode !== undefined && connection.certificate_mode !== "SYSTEM_CA" && connection.certificate_mode !== "CUSTOM_CA") {
      throw new Error(`connections[${index}].certificate_mode is invalid`)
    }
    for (const field of ["certificate_not_before", "certificate_not_after"] as const) {
      const value = connection[field]
      if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || value < 0)) {
        throw new Error(`connections[${index}].${field} is invalid`)
      }
    }
    if (connection.certificate_mode === "CUSTOM_CA" && (
      connection.certificate_not_before === undefined ||
      connection.certificate_not_before === null ||
      connection.certificate_not_after === undefined ||
      connection.certificate_not_after === null ||
      connection.certificate_not_after <= connection.certificate_not_before
    )) {
      throw new Error(`connections[${index}] custom certificate window is invalid`)
    }
    if (connectionsById.has(connection.connection_id)) throw new Error(`connections contain duplicate connection_id: ${connection.connection_id}`)
    connectionsById.set(connection.connection_id, connection as unknown as GatewayRoutingConnectionFact)
  }
  const mappingIds = new Set<string>()
  for (const [index, mapping] of input.model_mappings.entries()) {
    assertModelMapping(mapping, input.tenant_id, index)
    if (mappingIds.has(mapping.mapping_id)) {
      throw new Error(`model_mappings contain duplicate mapping_id: ${mapping.mapping_id}`)
    }
    mappingIds.add(mapping.mapping_id)
    const model = modelsById.get(mapping.public_model_id)
    if (!model) {
      throw new Error(
        `model_mappings[${index}] references unknown Public Model ${mapping.public_model_id}`,
      )
    }
    if (mapping.resource_id !== model.resource_id) {
      throw new Error(
        `mapping ${mapping.mapping_id} Resource does not match Public Model ${mapping.public_model_id}`,
      )
    }
    const connection = connectionsById.get(mapping.connection_id)
    if (!connection || connection.resource_id !== mapping.resource_id) {
      throw new Error(`mapping ${mapping.mapping_id} references an unknown Resource-owned Connection`)
    }
    const modelMappings = mappingsByModelId.get(mapping.public_model_id) ?? []
    if (modelMappings.some((candidate) => candidate.connection_id === mapping.connection_id)) {
      throw new Error(
        `Public Model ${mapping.public_model_id} repeats Connection ${mapping.connection_id}`,
      )
    }
    modelMappings.push(mapping)
    mappingsByModelId.set(mapping.public_model_id, modelMappings)
  }

  const pricingByMappingId = new Map<string, GatewayRoutingPricingFact>()
  for (const [index, pricing] of (input.pricing ?? []).entries()) {
    if (!isRecord(pricing)) throw new Error(`pricing[${index}] is invalid`)
    identifier(pricing.mapping_id, `pricing[${index}].mapping_id`)
    identifier(pricing.currency, `pricing[${index}].currency`)
    identifier(pricing.source, `pricing[${index}].source`)
    identifier(pricing.version, `pricing[${index}].version`)
    if (!/^[A-Z]{3}$/.test(pricing.currency)) throw new Error(`pricing[${index}].currency is invalid`)
    for (const field of ["input_cost_per_token_micros", "output_cost_per_token_micros"] as const) {
      if (typeof pricing[field] !== "number" || !Number.isFinite(pricing[field]) || pricing[field] < 0) {
        throw new Error(`pricing[${index}].${field} is invalid`)
      }
    }
    if (!mappingIds.has(pricing.mapping_id)) throw new Error(`pricing[${index}] references unknown mapping ${pricing.mapping_id}`)
    if (pricingByMappingId.has(pricing.mapping_id)) throw new Error(`pricing contains duplicate mapping_id ${pricing.mapping_id}`)
    pricingByMappingId.set(pricing.mapping_id, pricing as unknown as GatewayRoutingPricingFact)
  }

  const policiesByScope = new Map<string, ModelRoutingPolicy[]>()
  const policyRevisionKeys = new Set<string>()
  for (const [index, policy] of input.routing_policies.entries()) {
    assertRoutingPolicy(policy, input.tenant_id, index)
    const scope = routeKey(policy.resource_id, policy.capability_id)
    const revisionKey = `${scope}\u0000${policy.routing_revision}`
    if (policyRevisionKeys.has(revisionKey)) {
      throw new Error(`routing_policies contain duplicate revision: ${revisionKey}`)
    }
    policyRevisionKeys.add(revisionKey)
    const scopedPolicies = policiesByScope.get(scope) ?? []
    scopedPolicies.push(policy)
    policiesByScope.set(scope, scopedPolicies)
  }

  const scopes = projections
    .map((projection) => {
      const owner = ownersByResource.get(projection.resource_id)
      if (!owner) {
        throw new Error(`Resource ${projection.resource_id} has no owner reference`)
      }
      const policies = policiesByScope.get(routeKey(projection.resource_id, projection.capability_id)) ?? []
      if (policies.length !== 1) {
        throw new Error(
          `projected AI route ${routeKey(projection.resource_id, projection.capability_id)} must have exactly one routing policy`,
        )
      }
      return compileScope(
        projection,
        owner,
        policies[0]!,
        modelsById,
        mappingsByModelId,
        connectionsById,
        pricingByMappingId,
        input.issued_at,
      )
    })
    .sort((left, right) => compareTuple(
      [left.resource_id, left.capability_id],
      [right.resource_id, right.capability_id],
    ))

  return validateGatewayRoutingArtifact({
    schema_version: "genio.one.gateway-routing.v1",
    tenant_id: input.tenant_id,
    gateway_id: input.gateway_id,
    revision: input.revision,
    policy_version: input.policy_version,
    issued_at: input.issued_at,
    expires_at: input.expires_at,
    scopes,
  })
}
