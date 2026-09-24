import { timingSafeEqual } from "node:crypto"

import {
  DISTILLATION_CLASSIFIER_VERSION,
  DISTILLATION_QUESTIONS,
  fitDistillationExcerpt,
  mapDistillationAnswers,
  type DistillationTriage,
} from "@genioone/protocol/distillation-triage"

import {
  MAX_SAFETY_STATE_BYTES,
  systemOneQuestionsForChecks,
  systemOneQuestionsWithinRequestBudget,
  type ProcessorAdapterRuntime,
  type SafetyAdapterClient,
} from "./processor-adapters"

if (!systemOneQuestionsWithinRequestBudget(DISTILLATION_QUESTIONS)) {
  throw new Error("distillation questions exceed the SystemOne request budget")
}

const QUESTIONS = systemOneQuestionsForChecks(DISTILLATION_QUESTIONS)

export async function evaluateDistillationTriage(
  client: Pick<SafetyAdapterClient, "evaluate">,
  text: string,
  timeoutMs = 10_000,
): Promise<DistillationTriage> {
  const fitted = fitDistillationExcerpt(text)
  const state = { messages: [{ role: "user", content: fitted.text }] }
  if (Buffer.byteLength(JSON.stringify(state), "utf8") > MAX_SAFETY_STATE_BYTES) {
    return { status: "UNAVAILABLE", classifier_version: DISTILLATION_CLASSIFIER_VERSION }
  }
  try {
    const response = await client.evaluate({ state, questions: QUESTIONS }, timeoutMs)
    return mapDistillationAnswers(response.answers)
  } catch {
    return { status: "UNAVAILABLE", classifier_version: DISTILLATION_CLASSIFIER_VERSION }
  }
}

function tokenMatches(expected: string, presented: string): boolean {
  const left = Buffer.from(expected)
  const right = Buffer.from(presented)
  return left.length === right.length && timingSafeEqual(left, right)
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status })
}

export async function handleDistillationTriageRequest(input: {
  authorization: string | null
  body: Uint8Array
  token: string
  runtime: ProcessorAdapterRuntime
}): Promise<Response> {
  const presented = /^Bearer\s+(\S+)$/i.exec(input.authorization?.trim() ?? "")?.[1]
  if (!presented || !tokenMatches(input.token, presented)) {
    return json(401, { code: "DISTILLATION_TRIAGE_UNAUTHENTICATED" })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.body))
  } catch {
    return json(400, { code: "DISTILLATION_TRIAGE_REJECTED" })
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return json(400, { code: "DISTILLATION_TRIAGE_REJECTED" })
  }
  const record = parsed as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.some((key) => !["tenant_id", "adapter_id", "text"].includes(key))) {
    return json(400, { code: "DISTILLATION_TRIAGE_REJECTED" })
  }
  const tenantId = record.tenant_id
  const adapterId = record.adapter_id
  const rawText = record.text
  if (typeof tenantId !== "string" || typeof adapterId !== "string" || typeof rawText !== "string") {
    return json(400, { code: "DISTILLATION_TRIAGE_REJECTED" })
  }
  const text = fitDistillationExcerpt(rawText).text.trim()
  if (!tenantId.trim() || !adapterId.trim() || !text) {
    return json(400, { code: "DISTILLATION_TRIAGE_REJECTED" })
  }
  let client: SafetyAdapterClient
  try {
    client = input.runtime.resolveSafetyAdapter(tenantId.trim(), adapterId.trim())
  } catch {
    return json(404, { code: "DISTILLATION_ADAPTER_NOT_FOUND" })
  }
  const triage = await evaluateDistillationTriage(client, text)
  return json(200, { classifier_version: DISTILLATION_CLASSIFIER_VERSION, triage })
}
