import { expect, test } from "bun:test"
import { render, screen } from "@testing-library/react"
import { createInstance } from "i18next"
import { I18nextProvider } from "react-i18next"

import { SheetWorkspaceRoot } from "@/components/ui/sheet"
import type { ApiGatewayActivityEvent, OverviewSnapshot } from "@/domain/contracts"
import { ApiGatewayTransactionSheet } from "@/features/activity/api-gateway-transaction-sheet"

const data: Pick<OverviewSnapshot, "applications" | "connections" | "identity" | "resources"> = {
  applications: [],
  connections: [],
  identity: null,
  resources: [],
}

const event = {
  correlation_id: "safety-activity-correlation",
  tenant_id: "tenant-safety",
  resource_id: "resource-safety",
  capability_id: "invoke",
  application_id: null,
  subject_id: "subject-safety",
  subject_display: null,
  acting_client_id: "client-safety",
  session_id: null,
  entitlement_id: null,
  usage_admission_id: null,
  usage_admission_disposition: "NOT_APPLICABLE",
  usage_admission_reason: null,
  consumer_organization_id: null,
  resource_owner_organization_id: null,
  use_case_id: null,
  enforcement_point_id: "AI_GATEWAY",
  route: "MANAGED",
  method: "POST",
  path: "/v1/chat/completions",
  status_code: 403,
  outcome: "BLOCKED",
  error_code: "DATA_PROTECTION_BLOCKED",
  latency_millis: 12,
  upstream_attempted: true,
  requested_model_id: "public-model",
  effective_model_id: "provider-model",
  provider_id: null,
  connection_id: null,
  downstream_identity_mode: null,
  mcp_method: null,
  mcp_tool: null,
  mcp_backend: null,
  processor_bundle_revision: "bundle-safety",
  processor_request_steps: [],
  processor_response_steps: [],
  data_classifications: [{
    classification: "PERSON",
    handling_action: "REDACT",
    source: "DLP_DETECTOR",
    source_version: "presidio-v1",
    detector_provider: "PRESIDIO",
    detector_adapter_id: "pii-detector",
    trust_level: "RUNTIME_OBSERVED",
    step_id: "request-dlp",
  }, {
    classification: "CREDIT_CARD",
    handling_action: "TOKENIZE",
    source: "DLP_DETECTOR",
    source_version: "builtin-v1",
    trust_level: "RUNTIME_OBSERVED",
    step_id: "legacy-token-vault",
  }],
  safety_decisions: [{
    adapter_id: "semantic-safety",
    provider: "HTTP",
    model: "gateway-safety-model-v1",
    check_id: "prompt-injection",
    score: 0.91,
    threshold: 0.7,
    decision: "BLOCK",
    direction: "response",
    step_id: "response-safety",
  }],
  input_tokens: null,
  output_tokens: null,
  total_tokens: null,
  route_mode: null,
  route_lease_id: null,
  route_lease_reused: null,
  routing_policy_id: null,
  routing_revision: null,
  candidate_set_digest: null,
  candidate_connection_ids: [],
  cost_estimation_status: "NOT_APPLICABLE",
  estimated_cost_currency: null,
  estimated_cost_micros: null,
  pricing_source: null,
  pricing_version: null,
  detail_availability: "NOT_CAPTURED",
  detail_ref: null,
  detail_expires_at: null,
  occurred_at: 1_700_000_000,
} as ApiGatewayActivityEvent

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  })
}

test("Gateway Activity displays provider safety decision receipts", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString()
    return url.includes("routing-reconstruction") ? json(null) : json([])
  }) as typeof fetch
  try {
    const i18n = createInstance()
    await i18n.init({ lng: "en", resources: { en: { translation: {} } } })
    render(
      <I18nextProvider i18n={i18n}>
        <SheetWorkspaceRoot>
          <ApiGatewayTransactionSheet
            tenantId="tenant-safety"
            event={event}
            auditEvent={null}
            data={data}
            open
            onOpenChange={() => {}}
          />
        </SheetWorkspaceRoot>
      </I18nextProvider>,
    )

    const receipt = await screen.findByTestId("gateway-processor-receipt")
    expect(receipt.textContent).toContain("Safety decision receipts")
    expect(receipt.textContent).toContain("response · response-safety")
    expect(receipt.textContent).toContain("semantic-safety · HTTP · gateway-safety-model-v1")
    expect(receipt.textContent).toContain("prompt-injection · Score: 0.91 · Threshold: 0.7")
    expect(receipt.textContent).toContain("PERSON · REDACT · DLP_DETECTOR · presidio-v1 · PRESIDIO · pii-detector · RUNTIME_OBSERVED")
    expect(receipt.textContent).toContain("CREDIT_CARD · TOKENIZE · DLP_DETECTOR · builtin-v1 · RUNTIME_OBSERVED")
    expect(receipt.textContent).not.toContain("undefined")
    expect(receipt.textContent).toContain("BLOCK")
  } finally {
    globalThis.fetch = originalFetch
  }
})
