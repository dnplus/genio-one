import { expect, test } from "bun:test"

import {
  DISTILLATION_CLASSIFIER_VERSION,
  DISTILLATION_QUESTIONS,
  type DistillationTriage,
} from "@genioone/protocol/distillation-triage"

import { createHttpDistillationClassifier } from "./platform"

function triageResponse() {
  return {
    classifier_version: DISTILLATION_CLASSIFIER_VERSION,
    triage: {
      status: "CLASSIFIED",
      relevant: true,
      scope: "process",
      sensitivity: "standard",
      knowledge_type: "PROCEDURE",
      representation: "BOTH",
      classifier_version: DISTILLATION_CLASSIFIER_VERSION,
      evidence: DISTILLATION_QUESTIONS.map((question) => {
        const score = ["relevant", "scope_process", "type_procedure"].includes(question.id) ? 0.9 : 0.1
        return { check_id: question.id, score, threshold: question.threshold, matched: score >= question.threshold }
      }),
    },
  }
}

function classifier(body: unknown) {
  return createHttpDistillationClassifier({
    url: "http://triage.test/v1/distillation",
    token: "triage-token",
    adapterId: "adapter",
    fetchImpl: (async () => Response.json(body)) as unknown as typeof fetch,
  })
}

test("accepts complete classified and unavailable triage responses", async () => {
  const classified = triageResponse()
  expect(await classifier(classified).classify("tenant", "text")).toEqual(classified.triage as DistillationTriage)
  expect(await classifier({
    classifier_version: DISTILLATION_CLASSIFIER_VERSION,
    triage: { status: "UNAVAILABLE", classifier_version: DISTILLATION_CLASSIFIER_VERSION },
  }).classify("tenant", "text")).toEqual({
    status: "UNAVAILABLE",
    classifier_version: DISTILLATION_CLASSIFIER_VERSION,
  })
})

test("converts malformed successful triage responses into unavailable", async () => {
  const outerVersion = triageResponse()
  outerVersion.classifier_version = "jev-distillation-2"
  const innerVersion = triageResponse()
  innerVersion.triage.classifier_version = "jev-distillation-2"
  const invalidStatus = triageResponse()
  invalidStatus.triage.status = "RELATED"
  const missingField = triageResponse()
  Reflect.deleteProperty(missingField.triage, "relevant")
  const invalidScope = triageResponse()
  invalidScope.triage.scope = "private"
  const invalidScore = triageResponse()
  invalidScore.triage.evidence[0]!.score = 1.1
  const malformedEvidence = triageResponse()
  Reflect.deleteProperty(malformedEvidence.triage.evidence[0]!, "matched")
  const unknownEvidence = triageResponse()
  Reflect.set(unknownEvidence.triage.evidence[0]!, "check_id", "unexpected")
  const falseUnrelated = triageResponse()
  falseUnrelated.triage.relevant = false
  falseUnrelated.triage.scope = "unrelated"
  const extraField = { ...triageResponse(), extra: true }
  const unavailable = { status: "UNAVAILABLE", classifier_version: DISTILLATION_CLASSIFIER_VERSION } satisfies DistillationTriage
  for (const body of [outerVersion, innerVersion, invalidStatus, missingField, invalidScope, invalidScore, malformedEvidence, unknownEvidence, falseUnrelated, extraField]) {
    expect(await classifier(body).classify("tenant", "text")).toEqual(unavailable)
  }
})
