import { PlatformApiError } from "../errors"
import type { ConnectionModelMapping, PublicModel } from "../models/contract"
import type { PublicModelCatalog } from "../models/module"
import type {
  ClassifierResult,
  ModelRouteLease,
  ResolveModelRouteInput,
  SemanticRoutingRequest,
} from "./contract"

export interface RoutableModel {
  model: PublicModel
  mapping: ConnectionModelMapping
}

interface PreparedModelRouteBase {
  candidates: RoutableModel[]
  context: {
    subjectId: string
    clientId: string
    publicModelId: string
  }
  semanticRouting: SemanticRoutingRequest | null
}

export type PreparedModelRoute = PreparedModelRouteBase & (
  | { deterministic: ModelRouteLease; sessionId: null }
  | { deterministic: null; sessionId: string }
)

function applyClassifier(
  candidates: RoutableModel[],
  entitledPublicModelIds: ReadonlySet<string>,
  classifier: ClassifierResult | undefined,
): RoutableModel[] {
  if (!classifier) return candidates

  const outsideEntitlement = classifier.public_model_ids.filter(
    (modelId) => !entitledPublicModelIds.has(modelId),
  )
  if (outsideEntitlement.length > 0) {
    throw new PlatformApiError(
      "CLASSIFIER_CANDIDATE_NOT_ENTITLED",
      403,
      "A semantic classifier cannot expand the entitled public-model candidate set",
    )
  }

  if (classifier.mode === "FILTER") {
    const selected = new Set(classifier.public_model_ids)
    return candidates.filter((candidate) => selected.has(candidate.model.model_id))
  }

  const order = new Map(
    classifier.public_model_ids.map((modelId, index) => [modelId, index]),
  )
  return [...candidates].sort((left, right) => {
    const leftRank = order.get(left.model.model_id) ?? Number.MAX_SAFE_INTEGER
    const rightRank = order.get(right.model.model_id) ?? Number.MAX_SAFE_INTEGER
    return (
      leftRank - rightRank ||
      left.model.model_id.localeCompare(right.model.model_id) ||
      left.mapping.mapping_id.localeCompare(right.mapping.mapping_id)
    )
  })
}

async function eligibleModels(
  models: PublicModelCatalog,
  tenantId: string,
  input: ResolveModelRouteInput,
): Promise<RoutableModel[]> {
  const entitledPublicModelIds = new Set(input.entitled_public_model_ids)
  const publicModels = (await models.list({ tenantId }))
    .filter((model) => model.visibility === "PUBLIC" && model.lifecycle === "PUBLISHED")
    .filter((model) => entitledPublicModelIds.has(model.model_id))
    .sort((left, right) => left.model_id.localeCompare(right.model_id))

  const candidates: RoutableModel[] = []
  for (const model of publicModels) {
    const mappings = await models.listMappings({
      tenantId,
      resourceId: model.resource_id,
      publicModelId: model.model_id,
      readyOnly: true,
    })
    for (const mapping of mappings) candidates.push({ model, mapping })
  }

  const classified = applyClassifier(
    candidates,
    entitledPublicModelIds,
    input.classifier_result,
  )
  if (input.requested_public_model_id) {
    const requested = classified.filter(
      (candidate) => candidate.model.model_id === input.requested_public_model_id,
    )
    if (requested.length > 0) return requested
    if (!publicModels.some((model) => model.model_id === input.requested_public_model_id)) {
      throw new PlatformApiError("MODEL_NOT_ENTITLED", 403)
    }
    throw new PlatformApiError("MODEL_NOT_ELIGIBLE", 403)
  }
  return classified
}

export async function prepareModelRoute(
  models: PublicModelCatalog,
  tenantId: string,
  input: ResolveModelRouteInput,
  issuedAt: number,
): Promise<PreparedModelRoute> {
  const context = {
    subjectId: input.subject_id,
    clientId: input.client_id,
    publicModelId: input.public_model_id,
  }
  if (input.classifier_result && !input.session_id) {
    throw new PlatformApiError(
      "SEMANTIC_ROUTING_REQUIRES_SESSION",
      422,
      "Semantic routing requires a session-scoped route lease",
    )
  }
  if (input.semantic_routing && !input.session_id) {
    throw new PlatformApiError(
      "SEMANTIC_ROUTING_REQUIRES_SESSION",
      422,
      "Semantic routing requires a session-scoped route lease",
    )
  }
  if (input.semantic_routing && input.classifier_result) {
    throw new PlatformApiError(
      "SEMANTIC_ROUTING_INPUT_CONFLICT",
      422,
      "Semantic routing cannot be combined with a caller-supplied classifier result",
    )
  }
  if (input.semantic_routing && input.requested_public_model_id) {
    throw new PlatformApiError(
      "SEMANTIC_ROUTING_INPUT_CONFLICT",
      422,
      "Semantic routing cannot be combined with an explicit Public Model request",
    )
  }
  if (input.semantic_routing && !input.semantic_routing.task.trim()) {
    throw new PlatformApiError("SEMANTIC_ROUTING_TASK_REQUIRED", 422)
  }
  const candidates = await eligibleModels(models, tenantId, input)
  if (input.session_id) {
    return {
      candidates,
      context,
      deterministic: null,
      semanticRouting: input.semantic_routing ?? null,
      sessionId: input.session_id,
    }
  }

  const selected = candidates[0]
  if (!selected) throw new PlatformApiError("NO_ELIGIBLE_MODEL", 403)
  return {
    candidates,
    context,
    semanticRouting: null,
    sessionId: null,
    deterministic: {
      tenant_id: tenantId,
      subject_id: context.subjectId,
      client_id: context.clientId,
      public_model_id: context.publicModelId,
      selected_public_model_id: selected.model.model_id,
      mapping_id: selected.mapping.mapping_id,
      provider_model: selected.mapping.provider_model,
      mapping_revision: selected.mapping.mapping_revision,
      resource_id: selected.model.resource_id,
      connection_id: selected.mapping.connection_id,
      issued_at: issuedAt,
      reused: false,
      route_mode: "DETERMINISTIC",
    },
  }
}
