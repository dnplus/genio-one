import { expect, test } from "bun:test"

import { DISTILLATION_QUESTIONS } from "@genioone/protocol/distillation-triage"

import { evaluateDistillationTriage, handleDistillationTriageRequest } from "./distillation-triage"
import type { ProcessorAdapterRuntime, SafetyAdapterClient } from "./processor-adapters"

function client(answers: Record<string, number>, fail = false): SafetyAdapterClient {
  return {
    adapterId: "jev-production",
    provider: "JEV",
    endpoint: "https://api.typesafe.ai/v1/systemone",
    model: "jev-latest",
    async evaluate(input) {
      if (fail) throw new Error("down")
      expect(Object.keys(input.questions).sort()).toEqual(DISTILLATION_QUESTIONS.map((question) => question.id).sort())
      const state = input.state as { messages: Array<{ content: string }> }
      expect(state.messages[0]?.content).toBe("可重用的部署步驟")
      return {
        model: "jev-latest",
        answers: Object.fromEntries(DISTILLATION_QUESTIONS.map((question) => [
          question.id,
          { type: "noul" as const, noul: answers[question.id] ?? 0.1 },
        ])),
      }
    },
  }
}

test("Jev evidence is mapped without treating an adapter failure as unrelated", async () => {
  const classified = await evaluateDistillationTriage(client({ relevant: 0.95, scope_process: 0.8, type_procedure: 0.9 }), "可重用的部署步驟")
  expect(classified.status).toBe("CLASSIFIED")
  if (classified.status !== "CLASSIFIED") return
  expect(classified.relevant).toBe(true)
  expect(classified.scope).toBe("process")
  expect(classified.knowledge_type).toBe("PROCEDURE")
  expect(await evaluateDistillationTriage(client({}, true), "可重用的部署步驟")).toEqual({
    status: "UNAVAILABLE",
    classifier_version: "jev-distillation-1",
  })
})

test("the triage route rejects a missing token and does not echo the excerpt", async () => {
  const runtime = {
    resolveSafetyAdapter: () => client({ relevant: 0.2 }),
  } as unknown as ProcessorAdapterRuntime
  const denied = await handleDistillationTriageRequest({
    authorization: null,
    body: Buffer.from(JSON.stringify({ tenant_id: "tenant", adapter_id: "jev", text: "secret excerpt" })),
    token: "triage-token",
    runtime,
  })
  expect(denied.status).toBe(401)
  const accepted = await handleDistillationTriageRequest({
    authorization: "Bearer triage-token",
    body: Buffer.from(JSON.stringify({ tenant_id: "tenant", adapter_id: "jev", text: "可重用的部署步驟" })),
    token: "triage-token",
    runtime,
  })
  expect(accepted.status).toBe(200)
  const body = await accepted.json() as { triage: { status: string } }
  expect(JSON.stringify(body).includes("可重用的部署步驟")).toBe(false)
  expect(body.triage.status).toBe("CLASSIFIED")
})
