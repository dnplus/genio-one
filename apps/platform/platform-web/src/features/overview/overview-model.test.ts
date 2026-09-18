import assert from "node:assert/strict"
import test from "node:test"
import { createMockOverview } from "@/mocks/overview"
import { buildOverviewNodes, runtimeFilterForProductLane } from "./overview-model"
import { buildAttentionItems } from "./attention-list"

const gatewayNode = (data: ReturnType<typeof createMockOverview>) => buildOverviewNodes(data).find((node) => node.id === "gateway")!

test("registered Gateways without reports are unknown rather than absent, and require attention", () => {
  const data = createMockOverview()
  data.failures = []
  data.runtimes = data.runtimes.filter((runtime) => runtime.runtime_kind === "GATEWAY").map((runtime) => ({ ...runtime, observed_state: null, operator_state: "AWAITING_REPORT", in_sync: false }))
  assert.ok(gatewayNode(data).breakdown.every((item) => item.value === "Awaiting report"))
  const attention = buildAttentionItems(data).find((item) => item.id === "unhealthy-gateways")!
  assert.equal(attention.count, data.runtimes.length)
  assert.equal(attention.filter, "GATEWAY")
})

test("partial reporting cannot imply an unreported module is not installed", () => {
  const data = createMockOverview()
  data.runtimes = data.runtimes.filter((runtime) => runtime.runtime_kind === "GATEWAY")
  data.runtimes[0]!.observed_state = null
  for (const runtime of data.runtimes.slice(1)) runtime.observed_state!.components = []
  assert.ok(gatewayNode(data).breakdown.every((item) => item.value === "Awaiting report"))
  data.runtimes = []
  data.gatewayRegistrations = []
  assert.ok(gatewayNode(data).breakdown.every((item) => item.value === "Not reported"))
})

test("a stale healthy component report cannot make an offline Gateway ready", () => {
  const data = createMockOverview()
  data.runtimes = data.runtimes.filter((runtime) => runtime.runtime_kind === "GATEWAY")
  for (const runtime of data.runtimes) {
    runtime.connected = false
    runtime.operator_state = "OFFLINE"
    runtime.observed_state!.components = [{ component: "AI_MCP_GATEWAY", health: "READY", applied_config_revision: "r1", detail: null }]
  }
  assert.equal(gatewayNode(data).breakdown.find((item) => item.filter === "AI_MCP_GATEWAY")!.value, "Degraded")
})

test("maps the runtime AI_GATEWAY report to the overview lane and runtime filter", () => {
  const data = createMockOverview()
  for (const runtime of data.runtimes.filter((candidate) => candidate.runtime_kind === "GATEWAY")) {
    if (!runtime.observed_state) continue
    runtime.observed_state.components = [{
      component: "AI_GATEWAY",
      applied_config_revision: "r1",
      applied_enforcement_bundle_revision: null,
      health: "READY",
      detail: null,
    }]
  }
  assert.equal(gatewayNode(data).breakdown.find((item) => item.filter === "AI_MCP_GATEWAY")!.value, "Ready")
  assert.equal(runtimeFilterForProductLane("AI_MCP_GATEWAY"), "AI_GATEWAY")
  for (const runtime of data.runtimes) {
    if (!runtime.observed_state) continue
    runtime.observed_state.components = runtime.observed_state.components.map((component) => ({ ...component, component: "AUTHORIZER" }))
  }
  assert.equal(gatewayNode(data).breakdown.find((item) => item.filter === "AI_MCP_GATEWAY")!.value, "Not reported")
})
