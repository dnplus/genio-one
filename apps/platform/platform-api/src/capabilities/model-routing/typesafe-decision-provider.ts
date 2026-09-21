import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk"

import type {
  ModelRoutingDecisionCandidate,
  ModelRoutingDecisionProvider,
  ModelRoutingDecisionResult,
} from "./decision-provider"

const TASK_KINDS = {
  GENERAL: "Ordinary conversation, drafting, summarization, or broad knowledge work",
  REASONING: "Complex analysis, planning, debugging, or multi-step judgment",
  TOOL_USE: "The task depends on calling tools, APIs, code execution, or external systems",
  VISION: "The task requires understanding images or rendered visual content",
  TRANSCRIPTION: "The task requires speech or audio transcription",
} as const

const COMPLEXITY_LEVELS = [
  "Simple lookup, short transformation, or one obvious step",
  "Several steps or moderate judgment, with a clear completion condition",
  "Complex planning, ambiguity, specialist reasoning, or costly recovery from a wrong route",
] as const

export interface TypeSafeRoutingEvaluation {
  model: string
  route: {
    choice: string
    confidence: number
    probabilities: Readonly<Record<string, number>>
  }
  task_kind: {
    choice: keyof typeof TASK_KINDS
    confidence: number
  }
  complexity: {
    score: number
    confidence: number
  }
  requires_tools: {
    noul: number
  }
  usage: {
    input_tokens: number
    output_tokens: number
  }
  request_id?: string
}

export interface TypeSafeRoutingEvaluator {
  evaluate(input: {
    task: string
    candidates: readonly ModelRoutingDecisionCandidate[]
    model: string
  }): Promise<TypeSafeRoutingEvaluation>
}

function sdkEvaluator(client: TypeSafeClient): TypeSafeRoutingEvaluator {
  return {
    async evaluate(input) {
      const routeCriteria = Object.fromEntries(input.candidates.map((candidate) => [
        candidate.public_model_id,
        {
          display_name: candidate.display_name,
          stable_name: candidate.model_name,
          capabilities: [...candidate.capabilities],
        },
      ]))
      const result = await client.systemOne({
        model: input.model,
        state: {
          task: input.task,
          candidates: input.candidates.map((candidate) => ({
            ...candidate,
            capabilities: [...candidate.capabilities],
          })),
        },
        questions: {
          route: choice(
            {
              decision: "Select the best eligible Public Model for this task",
              constraints: [
                "Choose only from the supplied candidate IDs",
                "Prefer the capability fit implied by the task and candidate metadata",
                "Do not infer authorization, price, privacy, latency, or health facts that are not supplied",
              ],
            },
            routeCriteria,
          ),
          task_kind: choice("What is the primary execution shape of the task?", TASK_KINDS),
          complexity: score("How complex is successful completion of this task?", COMPLEXITY_LEVELS),
          requires_tools: noul(
            "Does successful completion require tools, APIs, code execution, browser interaction, or another external system?",
          ),
        },
      }).withResponse()
      return {
        model: result.data.model,
        route: {
          choice: result.data.answers.route.choice,
          confidence: result.data.answers.route.confidence,
          probabilities: result.data.answers.route.probabilities,
        },
        task_kind: {
          choice: result.data.answers.task_kind.choice,
          confidence: result.data.answers.task_kind.confidence,
        },
        complexity: {
          score: result.data.answers.complexity.score,
          confidence: result.data.answers.complexity.confidence,
        },
        requires_tools: {
          noul: result.data.answers.requires_tools.noul,
        },
        usage: result.data.usage,
        ...(result.requestId ? { request_id: result.requestId } : {}),
      }
    },
  }
}

export interface TypeSafeModelRoutingDecisionProviderOptions {
  apiKey?: string
  baseURL?: string
  model?: string
  evaluator?: TypeSafeRoutingEvaluator
}

export function createTypeSafeModelRoutingDecisionProvider(
  options: TypeSafeModelRoutingDecisionProviderOptions,
): ModelRoutingDecisionProvider {
  const requestedModel = options.model?.trim() || "jev-1.13.0"
  const evaluator = options.evaluator ?? sdkEvaluator(new TypeSafeClient({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    defaultModel: requestedModel,
    logLevel: "off",
  }))
  return {
    provider_id: "typesafe-system-one",
    requested_model: requestedModel,
    async decide(input): Promise<ModelRoutingDecisionResult> {
      const result = await evaluator.evaluate({ ...input, model: requestedModel })
      return {
        resolved_model: result.model,
        suggested_public_model_id: result.route.choice,
        confidence: result.route.confidence,
        probabilities: result.route.probabilities,
        annotations: {
          task_kind: result.task_kind.choice,
          task_kind_confidence: result.task_kind.confidence,
          complexity_score: result.complexity.score,
          complexity_confidence: result.complexity.confidence,
          requires_tools_probability: result.requires_tools.noul,
        },
        usage: result.usage,
        ...(result.request_id ? { request_id: result.request_id } : {}),
      }
    },
  }
}

function configuredConfidence(value: string | undefined): number {
  const confidence = value?.trim() ? Number(value) : 0.6
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("GENIO_ONE_MODEL_ROUTING_DECISION_MIN_CONFIDENCE must be between 0 and 1")
  }
  return confidence
}

export function typeSafeModelRoutingFromEnvironment(
  environment: NodeJS.ProcessEnv,
): {
  provider: ModelRoutingDecisionProvider
  minimumConfidence: number
} | null {
  const apiKey = environment.TYPESAFE_API_KEY?.trim() || environment.JEV_API_KEY?.trim()
  if (!apiKey) return null
  return {
    provider: createTypeSafeModelRoutingDecisionProvider({
      apiKey,
      baseURL: environment.TYPESAFE_BASE_URL?.trim() || undefined,
      model: environment.GENIO_ONE_MODEL_ROUTING_DECISION_MODEL?.trim() || undefined,
    }),
    minimumConfidence: configuredConfidence(
      environment.GENIO_ONE_MODEL_ROUTING_DECISION_MIN_CONFIDENCE,
    ),
  }
}
