import { expect, test } from "bun:test"

import {
  DISTILLATION_QUESTIONS,
  DISTILLATION_TRIAGE_REQUEST_BYTE_LIMIT,
  fitDistillationExcerpt,
  mapDistillationAnswers,
} from "./distillation-triage"

function answers(overrides: Record<string, number> = {}) {
  return Object.fromEntries(DISTILLATION_QUESTIONS.map((question) => [
    question.id,
    { noul: overrides[question.id] ?? 0.1 },
  ]))
}

test("a matched customer signal outranks a higher product score and stays evidence-only", () => {
  const triage = mapDistillationAnswers(answers({
    relevant: 0.91,
    scope_customer_project: 0.72,
    scope_product: 0.99,
    sensitivity_restricted: 0.2,
    type_fact: 0.8,
  }))
  expect(triage.status).toBe("CLASSIFIED")
  if (triage.status !== "CLASSIFIED") return
  expect(triage.relevant).toBe(true)
  expect(triage.scope).toBe("customer_project")
  expect(triage.sensitivity).toBe("restricted")
  expect(triage.representation).toBe("EVIDENCE_ONLY")
})

test("an unmatched relevance question does not become a shared candidate", () => {
  const triage = mapDistillationAnswers(answers({ scope_shared: 0.99, type_skill: 0.99 }))
  expect(triage.status).toBe("CLASSIFIED")
  if (triage.status !== "CLASSIFIED") return
  expect(triage.relevant).toBe(false)
  expect(triage.scope).toBe("unrelated")
})

test("a missing or illegal Jev score stays unavailable", () => {
  const partial = answers()
  delete partial.relevant
  expect(mapDistillationAnswers(partial).status).toBe("UNAVAILABLE")
  expect(mapDistillationAnswers(answers({ relevant: 1.2 })).status).toBe("UNAVAILABLE")
  expect(mapDistillationAnswers(undefined).status).toBe("UNAVAILABLE")
})

test("relevant answers without a matched scope stay unavailable", () => {
  expect(mapDistillationAnswers(answers({ relevant: 0.9 })).status).toBe("UNAVAILABLE")
})

test("a quote-heavy excerpt is shortened to the serialized triage budget", () => {
  const fitted = fitDistillationExcerpt('"'.repeat(48_000))
  expect(fitted.truncated).toBe(true)
  expect(fitted.text.length).toBeGreaterThan(0)
  expect(Buffer.byteLength(JSON.stringify({ messages: [{ role: "user", content: fitted.text }] }), "utf8")).toBeLessThanOrEqual(96_000)
})

test("a fitted excerpt stays within the request limit for any valid 256-unit identifiers", () => {
  // The triage endpoint rejects bodies over 100,000 bytes with 413, so the fit
  // must hold for the largest serialized tenant and adapter IDs, not ASCII ones.
  const identifiers = ["t".repeat(256), "器".repeat(256), "\u0001".repeat(256), "\ud800".repeat(256), "\"".repeat(256)]
  for (const excerpt of ["a".repeat(200_000), "器".repeat(60_000), "\u0001".repeat(40_000)]) {
    const fitted = fitDistillationExcerpt(excerpt)
    expect(fitted.truncated).toBe(true)
    for (const tenantId of identifiers) {
      for (const adapterId of identifiers) {
        const request = JSON.stringify({ tenant_id: tenantId, adapter_id: adapterId, text: fitted.text })
        expect(Buffer.byteLength(request, "utf8")).toBeLessThanOrEqual(DISTILLATION_TRIAGE_REQUEST_BYTE_LIMIT)
      }
    }
  }
})

test("equal type scores prefer a skill over a fact", () => {
  const triage = mapDistillationAnswers(answers({
    relevant: 0.9,
    scope_process: 0.8,
    type_fact: 0.8,
    type_skill: 0.8,
  }))
  if (triage.status !== "CLASSIFIED") throw new Error("expected classification")
  expect(triage.knowledge_type).toBe("SKILL")
  expect(triage.representation).toBe("MACHINE")
})
