import { expect, test } from "bun:test"

import { createProcessorAdapterRuntime } from "../shared/processor-adapters"
import { createLocalDistillationTriageApp } from "./local-distillation-triage"

const app = createLocalDistillationTriageApp({
  token: "local-distillation-triage",
  runtime: createProcessorAdapterRuntime({ schema_version: 1, adapters: [] }),
})

test("the local triage backend is healthy before it can classify", async () => {
  const health = await app(new Request("http://127.0.0.1:8182/healthz"))
  expect(health.status).toBe(200)
  expect(await health.json()).toEqual({ status: "ok", component: "local-distillation-triage" })
})

test("triage rejects a missing token and an adapter the local registry does not have", async () => {
  const denied = await app(new Request("http://127.0.0.1:8182/v1/distillation-triage", {
    method: "POST",
    body: "{}",
  }))
  expect(denied.status).toBe(401)
  const missing = await app(new Request("http://127.0.0.1:8182/v1/distillation-triage", {
    method: "POST",
    headers: {
      authorization: "Bearer local-distillation-triage",
      "content-type": "application/json",
    },
    body: JSON.stringify({ tenant_id: "tenant", adapter_id: "jev-production", text: "部署步驟" }),
  }))
  expect(missing.status).toBe(404)
  expect(await missing.json()).toEqual({ code: "DISTILLATION_ADAPTER_NOT_FOUND" })
})
