import { PlatformApiError } from "../errors"
import type { PublicModelCatalog } from "../models/module"
import type {
  ModelRouteLease,
  ResolveModelRouteInput,
} from "./contract"
import type { ModelRouter } from "./module"
import type { ModelMemoryState } from "../models/state"
import { prepareModelRoute } from "./candidates"
import {
  applySemanticModelDecision,
  type ModelRoutingDecisionProvider,
} from "./decision-provider"

export interface ModelRouteLeaseKeyInput {
  tenantId: string
  subjectId: string
  clientId: string
  publicModelId: string
  sessionId: string
}

/**
 * A lease is scoped to the complete caller/model session tuple. JSON encoding
 * keeps user-controlled identifiers unambiguous without imposing delimiter
 * escaping rules on the persistence adapter that replaces this memory store.
 */
function modelRouteLeaseKey(input: ModelRouteLeaseKeyInput): string {
  return JSON.stringify([
    input.tenantId,
    input.subjectId,
    input.clientId,
    input.publicModelId,
    input.sessionId,
  ])
}

export interface ModelRouterMemoryOptions {
  state: ModelMemoryState
  models: PublicModelCatalog
  now?: () => number
  idFactory?: (sequence: number) => string
  decisionProvider?: ModelRoutingDecisionProvider
  decisionMinimumConfidence?: number
}

export function createInMemoryModelRouter(options: ModelRouterMemoryOptions): ModelRouter {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const idFactory = options.idFactory ?? ((sequence) => `model-lease-${sequence}`)

  return {
    async resolve(input: { tenantId: string; value: ResolveModelRouteInput }) {
      const currentTime = now()
      const prepared = await prepareModelRoute(options.models, input.tenantId, input.value, currentTime)
      if (prepared.deterministic) return prepared.deterministic
      const { candidates, context } = prepared

      const leaseKey = modelRouteLeaseKey({
        tenantId: input.tenantId,
        subjectId: context.subjectId,
        clientId: context.clientId,
        publicModelId: context.publicModelId,
        sessionId: prepared.sessionId,
      })
      const current = options.state.leases.get(leaseKey)
      if (current && current.expires_at !== undefined && current.expires_at > currentTime) {
        if (
          input.value.requested_public_model_id !== undefined &&
          input.value.requested_public_model_id !== current.selected_public_model_id
        ) {
          throw new PlatformApiError(
            "SESSION_MODEL_LEASE_EXISTS",
            409,
            "A model route is sticky for the session; start a new session to switch models",
          )
        }
        if (!candidates.some((candidate) =>
          candidate.model.model_id === current.selected_public_model_id &&
          candidate.mapping.mapping_id === current.mapping_id &&
          candidate.mapping.mapping_revision === current.mapping_revision &&
          candidate.mapping.provider_model === current.provider_model)) {
          throw new PlatformApiError(
            "SESSION_MODEL_ROUTE_CONFLICT",
            409,
            "The current session route is not eligible for this request",
          )
        }
        return { ...current, reused: true }
      }
      if (current) options.state.leases.delete(leaseKey)

      const routed = await applySemanticModelDecision({
        request: prepared.semanticRouting,
        provider: options.decisionProvider,
        minimumConfidence: options.decisionMinimumConfidence ?? 0.6,
        candidates,
        decidedAt: currentTime,
      })
      const selected = routed.candidates[0]
      if (!selected) throw new PlatformApiError("NO_ELIGIBLE_MODEL", 403)

      options.state.leaseSequence += 1
      const lease: ModelRouteLease = {
        tenant_id: input.tenantId,
        lease_id: idFactory(options.state.leaseSequence),
        subject_id: context.subjectId,
        client_id: context.clientId,
        public_model_id: context.publicModelId,
        selected_public_model_id: selected.model.model_id,
        session_id: prepared.sessionId,
        mapping_id: selected.mapping.mapping_id,
        provider_model: selected.mapping.provider_model,
        mapping_revision: selected.mapping.mapping_revision,
        resource_id: selected.model.resource_id,
        connection_id: selected.mapping.connection_id,
        issued_at: currentTime,
        expires_at: currentTime + (input.value.lease_seconds ?? 3_600),
        reused: false,
        route_mode: "SESSION_LEASE",
        ...(routed.receipt ? { decision_receipt: routed.receipt } : {}),
      }
      options.state.leases.set(leaseKey, lease)
      return lease
    },
  }
}
