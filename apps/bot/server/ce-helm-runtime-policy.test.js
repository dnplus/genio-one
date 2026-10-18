import assert from "node:assert/strict"
import { test } from "bun:test"
import { Database } from "bun:sqlite"

import { generateSecretValues } from "../../../tooling/ce-helm-values.mjs"
import {
  createRuntimePolicyResponseSigner,
  RUNTIME_POLICY_REQUEST_NONCE_HEADER,
  RUNTIME_POLICY_RESPONSE_KEY_ID_HEADER,
  RUNTIME_POLICY_RESPONSE_SIGNATURE_HEADER,
  RUNTIME_REPORT_KEY_ID_HEADER,
  RUNTIME_REPORT_SIGNATURE_HEADER,
  verifyRuntimeReport,
} from "../../../runtimes/gateway/services/shared/runtime-report-attestation"
import { createRuntimePolicyClient } from "./runtime-policy"
import { RuntimePolicyReportLedger } from "./runtime-policy-report-ledger"

const principal = { tenant_id: "tenant-ce", subject_id: "person-ce", acting_client_id: "genio-one-bot", scopes: ["genioone-invocation"] }
const input = { principal, botId: "bot-ce", capabilityId: "shell.exec", action: "expose", correlationId: "ce-signing-contract" }

function fixture(db) {
  const { literals, runtimeReport } = generateSecretValues()
  const other = generateSecretValues()
  const signer = createRuntimePolicyResponseSigner(runtimeReport.generatedResponseKeyId, literals.platformRuntimePolicyResponsePrivateKeyPem)
  const otherSigner = createRuntimePolicyResponseSigner(runtimeReport.generatedResponseKeyId, other.literals.platformRuntimePolicyResponsePrivateKeyPem)
  const ledger = new RuntimePolicyReportLedger(db)
  const requests = []
  const state = { wrongAuthorizeKey: false, wrongReportKey: false }
  const client = createRuntimePolicyClient({
    origin: "http://platform.test",
    environment: {
      GENIO_ONE_RUNTIME_REPORT_KEY_ID: runtimeReport.generatedKeyId,
      GENIO_ONE_RUNTIME_REPORT_PRIVATE_KEY_PEM: literals.botRuntimeReportPrivateKeyPem,
      GENIO_ONE_RUNTIME_POLICY_RESPONSE_VERIFICATION_KEYS_JSON: literals.platformRuntimePolicyResponseVerificationKeysJson,
    },
    reportLedger: ledger,
    fetch: async (url, init) => {
      const request = JSON.parse(init.body)
      const headers = new Headers(init.headers)
      assert.equal(headers.get(RUNTIME_REPORT_KEY_ID_HEADER), runtimeReport.generatedKeyId)
      assert.equal(verifyRuntimeReport(request, headers.get(RUNTIME_REPORT_SIGNATURE_HEADER), literals.botRuntimeReportPublicKeyPem), true)
      const authorize = url.pathname.endsWith("/runtime-authorize")
      requests.push(authorize ? "authorize" : "report")
      const response = authorize ? {
        tenant_id: principal.tenant_id, subject_id: principal.subject_id, client_id: principal.acting_client_id,
        bot_id: request.bot_id, runtime_id: request.runtime_id, capability_id: request.capability_id, action: request.action,
        target: "runtime:codex:shell.exec", policy_id: "one-policy.runtime.capabilities", policy_display_name: "Runtime capabilities",
        policy_revision: 1, decision: "ALLOW", reason_code: "RULE_ALLOW:shell", constraints: [], obligations: [],
        correlation_id: request.correlation_id, session_id: null, evaluated_at: 1_757_000_000,
      } : {
        tenant_id: request.tenant_id, correlation_id: request.correlation_id, bot_id: request.bot_id, runtime_id: request.runtime_id,
        capability_id: request.capability_id, action: request.action, session_id: request.session_id ?? null,
        audit_event_id: `${request.correlation_id}:authorize:report`, authorization_audit_event_id: `${request.correlation_id}:authorize`,
        phase: "REPORT", report_outcome: request.outcome, reason_code: "RULE_ALLOW:shell",
      }
      const payload = authorize
        ? { kind: "AUTHORIZE_RESPONSE", tenantId: principal.tenant_id, nonce: headers.get(RUNTIME_POLICY_REQUEST_NONCE_HEADER), request, response }
        : { kind: "REPORT_ACK", tenantId: principal.tenant_id, request, response }
      const responseSigner = (authorize ? state.wrongAuthorizeKey : state.wrongReportKey) ? otherSigner : signer
      return Response.json(response, { status: authorize ? 200 : 201, headers: {
        [RUNTIME_POLICY_RESPONSE_KEY_ID_HEADER]: responseSigner.keyId,
        [RUNTIME_POLICY_RESPONSE_SIGNATURE_HEADER]: responseSigner.sign(payload),
      } })
    },
  })
  return { client, ledger, requests, state }
}

test("CE generated environment authorizes and acknowledges reports through the Bot consumer", async () => {
  const db = new Database(":memory:")
  try {
    const { client, ledger, requests } = fixture(db)
    assert.equal((await client.authorize(input)).decision, "ALLOW")
    await client.report({ ...input, outcome: "COMPLETED" })
    assert.deepEqual(requests, ["authorize", "report"])
    assert.equal(ledger.get(principal.tenant_id, input.correlationId).delivered, true)
    assert.equal(ledger.pending().length, 0)
  } finally { db.close() }
})

test("CE generated trust rejects another installation's response key and retains untrusted report ACKs", async () => {
  const db = new Database(":memory:")
  try {
    const { client, ledger, requests, state } = fixture(db)
    state.wrongAuthorizeKey = true
    await assert.rejects(client.authorize(input), /RUNTIME_POLICY_RESPONSE_ATTESTATION_INVALID/)
    assert.equal(ledger.pending().length, 0)
    state.wrongAuthorizeKey = false
    assert.equal((await client.authorize(input)).decision, "ALLOW")
    state.wrongReportKey = true
    await client.report({ ...input, outcome: "COMPLETED" })
    assert.equal(ledger.get(principal.tenant_id, input.correlationId).delivered, false)
    assert.equal(ledger.pending().length, 1)
    state.wrongReportKey = false
    await client.replayPendingReports()
    assert.equal(ledger.get(principal.tenant_id, input.correlationId).delivered, true)
    assert.equal(ledger.pending().length, 0)
    assert.deepEqual(requests, ["authorize", "authorize", "report", "report"])
  } finally { db.close() }
})
