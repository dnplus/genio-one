import { createHash } from "node:crypto"

import { PlatformApiError } from "../errors"
import type {
  ModelRoutingDecisionAnnotations,
  ModelRoutingDecisionReceipt,
  SemanticRoutingRequest,
} from "./contract"
import type { RoutableModel } from "./candidates"

export interface ModelRoutingDecisionCandidate {
  public_model_id: string
  model_name: string
  display_name: string
  capabilities: readonly string[]
}

export interface ModelRoutingDecisionResult {
  resolved_model: string
  suggested_public_model_id: string
  confidence: number
  probabilities: Readonly<Record<string, number>>
  annotations: ModelRoutingDecisionAnnotations
  usage: {
    input_tokens: number
    output_tokens: number
  }
  request_id?: string
}

export interface ModelRoutingDecisionProvider {
  provider_id: string
  requested_model: string
  decide(input: {
    task: string
    candidates: readonly ModelRoutingDecisionCandidate[]
  }): Promise<ModelRoutingDecisionResult>
}

function probability(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new PlatformApiError("MODEL_ROUTING_DECISION_INVALID", 502, `${field} must be between 0 and 1`)
  }
  return value
}

function decisionCandidates(candidates: readonly RoutableModel[]): ModelRoutingDecisionCandidate[] {
  const values = new Map<string, ModelRoutingDecisionCandidate>()
  for (const candidate of candidates) {
    values.set(candidate.model.model_id, {
      public_model_id: candidate.model.model_id,
      model_name: candidate.model.model_name,
      display_name: candidate.model.display_name,
      capabilities: [...candidate.model.capabilities].sort(),
    })
  }
  return [...values.values()]
}

function assertUsage(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PlatformApiError("MODEL_ROUTING_DECISION_INVALID", 502, `${field} must be a non-negative integer`)
  }
  return value
}

function complexityScore(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 2) {
    throw new PlatformApiError(
      "MODEL_ROUTING_DECISION_INVALID",
      502,
      "annotations.complexity_score must be between 0 and 2",
    )
  }
  return value
}

export async function applySemanticModelDecision(input: {
  request: SemanticRoutingRequest | null
  provider?: ModelRoutingDecisionProvider
  minimumConfidence: number
  candidates: readonly RoutableModel[]
  decidedAt: number
}): Promise<{
  candidates: RoutableModel[]
  receipt: ModelRoutingDecisionReceipt | undefined
}> {
  if (!input.request) return { candidates: [...input.candidates], receipt: undefined }
  if (!input.provider) {
    throw new PlatformApiError(
      "MODEL_ROUTING_DECISION_UNAVAILABLE",
      503,
      "Semantic model routing is not configured",
    )
  }
  if (!Number.isFinite(input.minimumConfidence) || input.minimumConfidence < 0 || input.minimumConfidence > 1) {
    throw new Error("minimumConfidence must be between 0 and 1")
  }

  const candidates = decisionCandidates(input.candidates)
  if (candidates.length === 0) throw new PlatformApiError("NO_ELIGIBLE_MODEL", 403)

  let decision: ModelRoutingDecisionResult
  try {
    decision = await input.provider.decide({ task: input.request.task, candidates })
  } catch (error) {
    if (error instanceof PlatformApiError) throw error
    throw new PlatformApiError(
      "MODEL_ROUTING_DECISION_UNAVAILABLE",
      503,
      "The semantic model-routing provider could not decide",
    )
  }

  const ids = new Set(candidates.map((candidate) => candidate.public_model_id))
  if (!ids.has(decision.suggested_public_model_id)) {
    throw new PlatformApiError(
      "MODEL_ROUTING_DECISION_INVALID",
      502,
      "The semantic model-routing provider selected an ineligible Public Model",
    )
  }
  const probabilities = candidates.map((candidate) => ({
    public_model_id: candidate.public_model_id,
    probability: probability(
      decision.probabilities[candidate.public_model_id],
      `probabilities.${candidate.public_model_id}`,
    ),
  }))
  const probabilityTotal = probabilities.reduce((sum, item) => sum + item.probability, 0)
  if (Math.abs(probabilityTotal - 1) > 0.02) {
    throw new PlatformApiError(
      "MODEL_ROUTING_DECISION_INVALID",
      502,
      "The semantic model-routing probabilities must sum to one",
    )
  }
  const highestProbability = Math.max(...probabilities.map((item) => item.probability))
  const suggestedProbability = probabilities.find(
    (item) => item.public_model_id === decision.suggested_public_model_id,
  )?.probability
  if (suggestedProbability === undefined || suggestedProbability < highestProbability) {
    throw new PlatformApiError(
      "MODEL_ROUTING_DECISION_INVALID",
      502,
      "The semantic model-routing choice must match the highest probability",
    )
  }
  const confidence = probability(decision.confidence, "confidence")
  const applied = confidence >= input.minimumConfidence
  const ranks = new Map(probabilities.map((item) => [item.public_model_id, item.probability]))
  const routed = applied
    ? [...input.candidates].sort((left, right) =>
        (ranks.get(right.model.model_id) ?? 0) - (ranks.get(left.model.model_id) ?? 0))
    : [...input.candidates]
  const selected = routed[0]
  if (!selected) throw new PlatformApiError("NO_ELIGIBLE_MODEL", 403)

  return {
    candidates: routed,
    receipt: {
      provider_id: input.provider.provider_id,
      requested_model: input.provider.requested_model,
      resolved_model: decision.resolved_model,
      suggested_public_model_id: decision.suggested_public_model_id,
      selected_public_model_id: selected.model.model_id,
      task_digest: createHash("sha256").update(input.request.task.trim()).digest("hex"),
      ...(decision.request_id ? { request_id: decision.request_id } : {}),
      applied,
      confidence,
      probabilities,
      annotations: {
        task_kind: decision.annotations.task_kind,
        task_kind_confidence: probability(decision.annotations.task_kind_confidence, "annotations.task_kind_confidence"),
        complexity_score: complexityScore(decision.annotations.complexity_score),
        complexity_confidence: probability(decision.annotations.complexity_confidence, "annotations.complexity_confidence"),
        requires_tools_probability: probability(decision.annotations.requires_tools_probability, "annotations.requires_tools_probability"),
      },
      usage: {
        input_tokens: assertUsage(decision.usage.input_tokens, "usage.input_tokens"),
        output_tokens: assertUsage(decision.usage.output_tokens, "usage.output_tokens"),
      },
      decided_at: input.decidedAt,
    },
  }
}
