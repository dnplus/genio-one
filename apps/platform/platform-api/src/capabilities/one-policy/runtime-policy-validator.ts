import { isRuntimeCapabilityAction } from "@genioone/protocol/runtime-capability-actions"

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
  for (const rule of definition.rules) {
    if (rule.constraints.length > 0) {
      throw new PlatformApiError("RUNTIME_POLICY_CONSTRAINT_UNSUPPORTED", 422)
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
}
