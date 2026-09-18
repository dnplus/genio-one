import { randomUUID } from "node:crypto"

import { PlatformApiError } from "../errors"
import type {
  CreateModelRoutingPolicyInput,
  ModelRoutingPolicy,
} from "./contract"
import {
  routingPolicyMatchesInput,
  routingPolicyScopeKey,
  validateCreateModelRoutingPolicy,
  validateModelRoutingPolicy,
} from "./policy"
import type {
  ModelRoutingPolicyRevisionKey,
  ModelRoutingPolicyScope,
  ModelRoutingPolicyStore,
} from "./module"

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

export interface InMemoryModelRoutingPolicyOptions {
  now?: () => number
  idFactory?: (prefix: string) => string
  /** Optional Resource authority lookup used by memory tests and previews. */
  resourceOwner?: (input: {
    tenantId: string
    resourceId: string
  }) => string | null | Promise<string | null>
}

function clone(policy: ModelRoutingPolicy): ModelRoutingPolicy {
  return {
    ...policy,
    candidate_public_model_ids: [...policy.candidate_public_model_ids],
    context_requirements: structuredClone(policy.context_requirements ?? []),
  }
}

function assertScopeValue(value: string, field: string): void {
  if (!value.trim() || value.trim() !== value || CONTROL_CHARACTERS.test(value)) {
    throw new PlatformApiError("MODEL_ROUTING_POLICY_SCOPE_INVALID", 422, `${field} is invalid`)
  }
}

function assertScope(scope: ModelRoutingPolicyScope): void {
  assertScopeValue(scope.tenantId, "tenantId")
  assertScopeValue(scope.ownerOrganizationId, "ownerOrganizationId")
  assertScopeValue(scope.resourceId, "resourceId")
  assertScopeValue(scope.capabilityId, "capabilityId")
}

function assertRevisionKey(key: ModelRoutingPolicyRevisionKey): void {
  assertScope(key)
  if (!Number.isSafeInteger(key.routingRevision) || key.routingRevision < 1) {
    throw new PlatformApiError(
      "MODEL_ROUTING_POLICY_REVISION_INVALID",
      422,
      "routingRevision must be a positive integer",
    )
  }
}

async function assertResourceOwner(
  options: InMemoryModelRoutingPolicyOptions,
  tenantId: string,
  resourceId: string,
  ownerOrganizationId: string,
): Promise<void> {
  if (!options.resourceOwner) return
  const owner = await options.resourceOwner({ tenantId, resourceId })
  if (!owner) {
    throw new PlatformApiError("MODEL_ROUTING_POLICY_RESOURCE_NOT_FOUND", 404)
  }
  if (owner !== ownerOrganizationId) {
    throw new PlatformApiError(
      "MODEL_ROUTING_POLICY_OWNER_MISMATCH",
      403,
      "The routing policy owner must own the Resource",
    )
  }
}

/** In-memory adapter for immutable, organization-scoped policy revisions. */
export function createInMemoryModelRoutingPolicyStore(
  options: InMemoryModelRoutingPolicyOptions = {},
): ModelRoutingPolicyStore {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const idFactory = options.idFactory ?? ((prefix: string) => `${prefix}-${randomUUID()}`)
  const values = new Map<string, ModelRoutingPolicy>()

  return {
    async save(input: { tenantId: string; value: CreateModelRoutingPolicyInput }) {
      assertScopeValue(input.tenantId, "tenantId")
      const value = validateCreateModelRoutingPolicy(input.value)
      await assertResourceOwner(
        options,
        input.tenantId,
        value.resource_id,
        value.owner_organization_id,
      )

      const key = routingPolicyScopeKey({
        tenantId: input.tenantId,
        ownerOrganizationId: value.owner_organization_id,
        resourceId: value.resource_id,
        capabilityId: value.capability_id,
        routingRevision: value.routing_revision,
      })
      const existing = values.get(key)
      if (existing) {
        if (!routingPolicyMatchesInput(existing, value)) {
          throw new PlatformApiError(
            "MODEL_ROUTING_POLICY_REVISION_CONFLICT",
            409,
            "An immutable routing-policy revision already has different content",
          )
        }
        return clone(existing)
      }

      const policyId = [...values.values()].find(
        (policy) =>
          policy.tenant_id === input.tenantId &&
          policy.owner_organization_id === value.owner_organization_id &&
          policy.resource_id === value.resource_id &&
          policy.capability_id === value.capability_id,
      )?.routing_policy_id ?? idFactory("routing-policy")

      const timestamp = now()
      const policy = validateModelRoutingPolicy({
        tenant_id: input.tenantId,
        routing_policy_id: policyId,
        owner_organization_id: value.owner_organization_id,
        resource_id: value.resource_id,
        capability_id: value.capability_id,
        routing_revision: value.routing_revision,
        mode: value.mode,
        candidate_public_model_ids: [...value.candidate_public_model_ids],
        default_public_model_id: value.default_public_model_id,
        session_lease_seconds: value.session_lease_seconds,
        context_requirements: structuredClone(value.context_requirements ?? []),
        created_at: timestamp,
        updated_at: timestamp,
      })
      values.set(key, policy)
      return clone(policy)
    },

    async get(key: ModelRoutingPolicyRevisionKey) {
      assertRevisionKey(key)
      const policy = values.get(routingPolicyScopeKey(key))
      return policy ? clone(policy) : null
    },

    async getLatest(scope: ModelRoutingPolicyScope) {
      assertScope(scope)
      let latest: ModelRoutingPolicy | undefined
      for (const policy of values.values()) {
        if (
          policy.tenant_id !== scope.tenantId ||
          policy.owner_organization_id !== scope.ownerOrganizationId ||
          policy.resource_id !== scope.resourceId ||
          policy.capability_id !== scope.capabilityId
        ) continue
        if (!latest || policy.routing_revision > latest.routing_revision) latest = policy
      }
      return latest ? clone(latest) : null
    },

    async list(input: {
      tenantId: string
      ownerOrganizationId: string
      resourceId?: string
      capabilityId?: string
    }) {
      assertScopeValue(input.tenantId, "tenantId")
      assertScopeValue(input.ownerOrganizationId, "ownerOrganizationId")
      if (input.resourceId !== undefined) assertScopeValue(input.resourceId, "resourceId")
      if (input.capabilityId !== undefined) assertScopeValue(input.capabilityId, "capabilityId")
      return [...values.values()]
        .filter(
          (policy) =>
            policy.tenant_id === input.tenantId &&
            policy.owner_organization_id === input.ownerOrganizationId &&
            (input.resourceId === undefined || policy.resource_id === input.resourceId) &&
            (input.capabilityId === undefined || policy.capability_id === input.capabilityId),
        )
        .sort(
          (left, right) =>
            left.resource_id.localeCompare(right.resource_id) ||
            left.capability_id.localeCompare(right.capability_id) ||
            right.routing_revision - left.routing_revision ||
            left.routing_policy_id.localeCompare(right.routing_policy_id),
        )
        .map(clone)
    },
  }
}
