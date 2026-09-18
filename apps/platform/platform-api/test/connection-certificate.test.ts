import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { PlatformApiError } from "../src/capabilities/errors"
import {
  connectionCertificateFromStored,
  parseConnectionCertificate,
} from "../src/capabilities/connections/certificate"
import { createHttpConnectionVerifier } from "../src/local-slice-verifiers"

const certificatePath = new URL("../../tests/fixtures/client-auth/test-client-ca.pem", import.meta.url)

test("connection certificates preserve system CA and self-signed metadata", async () => {
  const system = parseConnectionCertificate({ mode: "SYSTEM_CA" }, 1_800_000_000)
  assert.deepEqual(system, {
    mode: "SYSTEM_CA",
    certificate_pem: null,
    fingerprint_sha256: null,
    subject: null,
    issuer: null,
    is_self_signed: false,
    not_before: null,
    not_after: null,
    status: "NOT_CONFIGURED",
  })

  const pem = await readFile(certificatePath, "utf8")
  const parsed = parseConnectionCertificate({ mode: "CUSTOM_CA", certificate_pem: pem }, 1_800_000_000)
  assert.equal(parsed.mode, "CUSTOM_CA")
  assert.equal(parsed.is_self_signed, true)
  assert.match(parsed.fingerprint_sha256 ?? "", /^[a-f0-9]{64}$/)
  assert.equal(parsed.status, "VALID")
  assert.equal(connectionCertificateFromStored({
    mode: parsed.mode,
    certificate_pem: parsed.certificate_pem,
    fingerprint_sha256: parsed.fingerprint_sha256,
    subject: parsed.subject,
    issuer: parsed.issuer,
    is_self_signed: parsed.is_self_signed,
    not_before: parsed.not_before,
    not_after: parsed.not_after,
  }, 1_800_000_000).fingerprint_sha256, parsed.fingerprint_sha256)
})

test("connection certificate status exposes expiry windows and rejects invalid PEM", async () => {
  const pem = await readFile(certificatePath, "utf8")
  const valid = parseConnectionCertificate({ mode: "CUSTOM_CA", certificate_pem: pem }, 1_800_000_000)
  assert.equal(parseConnectionCertificate({ mode: "CUSTOM_CA", certificate_pem: pem }, (valid.not_after ?? 0) - 10 * 24 * 60 * 60).status, "EXPIRING")
  assert.equal(parseConnectionCertificate({ mode: "CUSTOM_CA", certificate_pem: pem }, valid.not_after ?? 0).status, "EXPIRED")
  assert.throws(
    () => parseConnectionCertificate({ mode: "CUSTOM_CA", certificate_pem: "not-a-certificate" }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "CONNECTION_CERTIFICATE_INVALID",
  )
})

test("custom connection trust material is passed to the HTTPS verifier without exposing a private key", async () => {
  const pem = await readFile(certificatePath, "utf8")
  const certificate = parseConnectionCertificate({ mode: "CUSTOM_CA", certificate_pem: pem }, 1_800_000_000)
  let observedInit: RequestInit | undefined
  const verifier = createHttpConnectionVerifier({
    allowHttp: true,
    allowedHosts: ["127.0.0.1"],
    fetcher: async (_input, init) => {
      observedInit = init
      return new Response(JSON.stringify({ data: [] }), { status: 200 })
    },
  })
  const verified = await verifier.verify({
    connection: {
      tenant_id: "tenant-test",
      connection_id: "connection-test",
      resource_id: "resource-test",
      display_name: "Test",
      connection_kind: "LLM",
      provider_type: "GENERIC_OPENAI_COMPATIBLE",
      provider_profile_id: "provider-test",
      endpoint: "http://127.0.0.1:19090/v1",
      mcp_selected_tools: [],
      mcp_tool_selection_operation_id: null,
      credential_ref: null,
      provider_credential_profile: null,
      downstream_identity: { mode: "NONE" },
      request_mapping: null,
      certificate,
      status: "DRAFT",
      configuration_revision: 1,
      lifecycle: "DRAFT",
      revoke_requested_after_release_revision: null,
      verification_state: "UNVERIFIED",
      health_state: "UNKNOWN",
      health_observed_at: null,
      health_source_revision: null,
      routing_priority: 0,
      region: null,
      supported_obligations: [],
      created_at: 1_800_000_000,
    },
  })
  assert.equal(verified, true)
  assert.equal((observedInit as RequestInit & { tls?: { ca?: string } }).tls?.ca, certificate.certificate_pem)
  assert.equal((observedInit as RequestInit & { tls?: { ca?: string } }).tls?.ca?.includes("PRIVATE KEY"), false)
})
