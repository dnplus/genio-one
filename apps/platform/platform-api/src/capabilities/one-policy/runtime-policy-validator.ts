import { isRuntimeCapabilityAction } from "@genioone/protocol/runtime-capability-actions"
import { isHandsExecutionPlacementTarget, readHandsExecutionPlacement } from "@genioone/protocol/hands-placement"

import { PlatformApiError } from "../errors"
import type { RuntimePolicyDefinition } from "./runtime"

export interface RuntimePolicyPublicationRegistry {
  supports(input: { runtimeId: string; capabilityId: string; action: string }): boolean
}

const defaultRegistry: RuntimePolicyPublicationRegistry = {
  supports({ runtimeId, capabilityId, action }) {
    return runtimeId === "codex" &&
      isRuntimeCapabilityAction(capabilityId, action)
  },
}

export function validateRuntimePolicyForPublication(
  definition: RuntimePolicyDefinition,
  registry: RuntimePolicyPublicationRegistry = defaultRegistry,
): void {
  const placementDomains = new Set<string>()
  for (const rule of definition.rules) {
    if (rule.constraints.length > 0) {
      if (rule.effect !== "ALLOW" || rule.actions.length !== 1 || !isHandsExecutionPlacementTarget(rule.target.runtime_id, rule.target.capability_id, rule.actions[0]!)) {
        throw new PlatformApiError("RUNTIME_POLICY_CONSTRAINT_UNSUPPORTED", 422)
      }
      try {
        const domain = readHandsExecutionPlacement(rule.constraints)
        if (domain) placementDomains.add(domain)
      } catch (error) {
        throw new PlatformApiError(error instanceof Error ? error.message : "POLICY_PLACEMENT_INVALID", 422)
      }
    }
    if (rule.obligations.some((obligation) => obligation.kind !== "audit")) {
      throw new PlatformApiError("RUNTIME_POLICY_OBLIGATION_UNSUPPORTED", 422)
    }
    for (const action of rule.actions) {
      if (!registry.supports({
        runtimeId: rule.target.runtime_id,
        capabilityId: rule.target.capability_id,
        action,
      })) {
        throw new PlatformApiError("RUNTIME_POLICY_TARGET_ACTION_UNSUPPORTED", 422)
      }
    }
  }
  if (placementDomains.size > 1) throw new PlatformApiError("POLICY_PLACEMENT_CONFLICT", 422)
}
