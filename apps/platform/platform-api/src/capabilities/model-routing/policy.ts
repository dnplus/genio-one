import { Check } from "typebox/value"

import { PlatformApiError } from "../errors"
import {
  CreateModelRoutingPolicySchema,
  ModelRoutingPolicySchema,
  type CreateModelRoutingPolicyInput,
  type ModelRoutingPolicy,
} from "./contract"

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

function invalidInput(code: string, message: string): never {
  throw new PlatformApiError(code, 422, message)
}

function invalidStoredPolicy(message: string): never {
  throw new PlatformApiError("MODEL_ROUTING_POLICY_DATA_INVALID", 500, message)
}

function assertIdentifier(value: string, field: string, stored = false): void {
  if (!value.trim() || value.trim() !== value || CONTROL_CHARACTERS.test(value)) {
    if (stored) invalidStoredPolicy(`Persisted routing policy ${field} is invalid`)
    invalidInput("MODEL_ROUTING_POLICY_INVALID", `${field} is invalid`)
  }
}

function validatePolicyValues(
  value: {
    owner_organization_id: string
    resource_id: string
    capability_id: string
    routing_revision: number
    mode: "DETERMINISTIC" | "SESSION_LEASE"
    candidate_public_model_ids: string[]
    default_public_model_id: string
    session_lease_seconds: number | null
    context_requirements?: Array<{
      consumer_organization_id: string
      use_case_id: string
      minimum_risk_level: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"
      required_obligation_kinds: string[]
    }>
  },
  stored = false,
): void {
  const fail = (code: string, message: string): never => {
    if (stored) invalidStoredPolicy(message)
    invalidInput(code, message)
  }

  assertIdentifier(value.owner_organization_id, "owner_organization_id", stored)
  assertIdentifier(value.resource_id, "resource_id", stored)
  assertIdentifier(value.capability_id, "capability_id", stored)
  assertIdentifier(value.default_public_model_id, "default_public_model_id", stored)

  if (!Number.isSafeInteger(value.routing_revision) || value.routing_revision < 1) {
    fail("MODEL_ROUTING_POLICY_INVALID", "routing_revision must be a positive integer")
  }
  if (value.candidate_public_model_ids.length === 0) {
    fail(
      "MODEL_ROUTING_POLICY_CANDIDATES_REQUIRED",
      "At least one candidate Public Model is required",
    )
  }

  const candidateIds = new Set<string>()
  for (const candidateId of value.candidate_public_model_ids) {
    assertIdentifier(candidateId, "candidate_public_model_id", stored)
    if (candidateIds.has(candidateId)) {
      fail(
        "MODEL_ROUTING_POLICY_CANDIDATES_DUPLICATE",
        "candidate_public_model_ids must not contain duplicates",
      )
    }
    candidateIds.add(candidateId)
  }
  if (!candidateIds.has(value.default_public_model_id)) {
    fail(
      "MODEL_ROUTING_POLICY_DEFAULT_NOT_CANDIDATE",
      "default_public_model_id must be present in candidate_public_model_ids",
    )
  }
  const requirementKeys = new Set<string>()
  for (const requirement of value.context_requirements ?? []) {
    assertIdentifier(requirement.consumer_organization_id, "context_requirements.consumer_organization_id", stored)
    assertIdentifier(requirement.use_case_id, "context_requirements.use_case_id", stored)
    const key = `${requirement.consumer_organization_id}\u0000${requirement.use_case_id}\u0000${requirement.minimum_risk_level}`
    if (requirementKeys.has(key)) {
      fail("MODEL_ROUTING_CONTEXT_REQUIREMENT_DUPLICATE", "context routing requirements must be unique")
    }
    requirementKeys.add(key)
    for (const obligation of requirement.required_obligation_kinds) {
      assertIdentifier(obligation, "context_requirements.required_obligation_kinds", stored)
    }
  }

  if (value.mode === "SESSION_LEASE") {
    if (
      value.session_lease_seconds === null ||
      !Number.isSafeInteger(value.session_lease_seconds) ||
      value.session_lease_seconds < 1 ||
      value.session_lease_seconds > 86_400
    ) {
      fail(
        "MODEL_ROUTING_POLICY_SESSION_TTL_REQUIRED",
        "SESSION_LEASE policies require a TTL between 1 and 86400 seconds",
      )
    }
  } else if (value.session_lease_seconds !== null) {
    fail(
      "MODEL_ROUTING_POLICY_SESSION_TTL_FORBIDDEN",
      "DETERMINISTIC policies must not define a session lease TTL",
    )
  }
}

/** Validate and return an immutable routing-policy revision input. */
export function validateCreateModelRoutingPolicy(
  value: unknown,
): CreateModelRoutingPolicyInput {
  if (!Check(CreateModelRoutingPolicySchema, value)) {
    throw new PlatformApiError(
      "MODEL_ROUTING_POLICY_INVALID",
      422,
      "The routing policy does not match the strict policy contract",
    )
  }
  const policy = value as CreateModelRoutingPolicyInput
  validatePolicyValues(policy)
  return policy
}

/** Validate a row returned from persistence before it crosses the module seam. */
export function validateModelRoutingPolicy(value: unknown): ModelRoutingPolicy {
  if (!Check(ModelRoutingPolicySchema, value)) {
    invalidStoredPolicy("Persisted routing policy does not match the strict policy contract")
  }
  const policy = value as ModelRoutingPolicy
  validatePolicyValues(policy, true)
  assertIdentifier(policy.tenant_id, "tenant_id", true)
  assertIdentifier(policy.routing_policy_id, "routing_policy_id", true)
  if (
    !Number.isSafeInteger(policy.created_at) ||
    policy.created_at < 0 ||
    !Number.isSafeInteger(policy.updated_at) ||
    policy.updated_at < 0
  ) {
    invalidStoredPolicy("Persisted routing policy timestamps are invalid")
  }
  return policy
}

/** Compare an immutable persisted revision with a replayed save request. */
export function routingPolicyMatchesInput(
  policy: ModelRoutingPolicy,
  input: CreateModelRoutingPolicyInput,
): boolean {
  return (
    policy.owner_organization_id === input.owner_organization_id &&
    policy.resource_id === input.resource_id &&
    policy.capability_id === input.capability_id &&
    policy.routing_revision === input.routing_revision &&
    policy.mode === input.mode &&
    policy.default_public_model_id === input.default_public_model_id &&
    policy.session_lease_seconds === input.session_lease_seconds &&
    policy.candidate_public_model_ids.length === input.candidate_public_model_ids.length &&
    policy.candidate_public_model_ids.every(
      (candidateId, index) => candidateId === input.candidate_public_model_ids[index],
    ) &&
    JSON.stringify(policy.context_requirements ?? []) === JSON.stringify(input.context_requirements ?? [])
  )
}

export function routingPolicyScopeKey(input: {
  tenantId: string
  ownerOrganizationId: string
  resourceId: string
  capabilityId: string
  routingRevision: number
}): string {
  return JSON.stringify([
    input.tenantId,
    input.ownerOrganizationId,
    input.resourceId,
    input.capabilityId,
    input.routingRevision,
  ])
}
