import assert from "node:assert/strict"
import test from "node:test"
import { createServer } from "node:http"
import { exportJWK, generateKeyPair, SignJWT } from "jose"

import { PlatformApiError } from "../src/capabilities/errors"
import type { FederationTrustRevision } from "../src/capabilities/federation/contract"
import { createOidcWorkloadAssertionVerifier } from "../src/capabilities/federation/verifier"

const trust = (jwksUri: string): FederationTrustRevision => ({
  tenant_id: "tenant-acme",
  trust_id: "federation-trust-1",
  revision: 1,
  application_id: "application-1",
  application_subject_id: "application-subject-1",
  display_name: "CI workload",
  issuer: "https://issuer.example.test",
  jwks_uri: jwksUri,
  audiences: ["genio-one-sts"],
  algorithms: ["RS256"],
  external_subject_id: "repo:acme/service:ref:main",
  required_claims: [{ name: "environment", value: "production" }],
  max_assertion_ttl_seconds: 600,
  state: "ACTIVE",
  created_by_subject_id: "person-owner",
  created_at: 1_000,
})

test("OIDC workload assertions require trusted signature, issuer, audience, subject, claims and bounded expiry", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true })
  const publicJwk = await exportJWK(publicKey)
  const payload = JSON.stringify({ keys: [{ ...publicJwk, kid: "workload-key", alg: "RS256", use: "sig" }] })
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(payload)
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  try {
    const selectedTrust = trust(`http://127.0.0.1:${address.port}/jwks`)
    const assertion = await new SignJWT({ environment: "production" })
      .setProtectedHeader({ alg: "RS256", kid: "workload-key" })
      .setIssuer(selectedTrust.issuer)
      .setAudience("genio-one-sts")
      .setSubject(selectedTrust.external_subject_id)
      .setJti("assertion-valid")
      .setIssuedAt(1_000)
      .setExpirationTime(1_600)
      .sign(privateKey)
    const verifier = createOidcWorkloadAssertionVerifier()
    const verified = await verifier.verify({ token: assertion, trust: selectedTrust, now: 1_001 })
    assert.equal(verified.subject, selectedTrust.external_subject_id)

    const wrongClaim = await new SignJWT({ environment: "development" })
      .setProtectedHeader({ alg: "RS256", kid: "workload-key" })
      .setIssuer(selectedTrust.issuer)
      .setAudience("genio-one-sts")
      .setSubject(selectedTrust.external_subject_id)
      .setJti("assertion-wrong-claim")
      .setIssuedAt(1_000)
      .setExpirationTime(1_600)
      .sign(privateKey)
    await assert.rejects(
      () => verifier.verify({ token: wrongClaim, trust: selectedTrust, now: 1_001 }),
      (error: unknown) => error instanceof PlatformApiError && error.code === "FEDERATION_ASSERTION_TRUST_MISMATCH",
    )

    const wrongAudience = await new SignJWT({ environment: "production" })
      .setProtectedHeader({ alg: "RS256", kid: "workload-key" })
      .setIssuer(selectedTrust.issuer)
      .setAudience("other-sts")
      .setSubject(selectedTrust.external_subject_id)
      .setJti("assertion-wrong-audience")
      .setIssuedAt(1_000)
      .setExpirationTime(1_600)
      .sign(privateKey)
    await assert.rejects(
      () => verifier.verify({ token: wrongAudience, trust: selectedTrust, now: 1_001 }),
      (error: unknown) => error instanceof PlatformApiError && error.code === "FEDERATION_ASSERTION_INVALID",
    )
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
    })
  }
})
