import assert from "node:assert/strict"
import test from "node:test"

import { PlatformApiError } from "../src/capabilities/errors"
import { createPostgresFederationService } from "../src/capabilities/federation/postgres"
import type { SqlAdapter, SqlQueryResult, SqlTransaction } from "../src/persistence/sql-adapter"

type Row = Record<string, unknown>

class FakeSql implements SqlAdapter, SqlTransaction {
  readonly calls: Array<{ text: string; parameters: readonly unknown[] }> = []

  constructor(private readonly rows: (text: string, parameters: readonly unknown[]) => Row[]) {}

  async query<Result extends Row = Row>(
    text: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlQueryResult<Result>> {
    this.calls.push({ text, parameters })
    const rows = this.rows(text, parameters) as Result[]
    return { rows, rowCount: rows.length }
  }

  async transaction<Result>(work: (transaction: SqlTransaction) => Promise<Result>): Promise<Result> {
    return work(this)
  }
}

const trustRow = {
  tenant_id: "tenant-acme",
  trust_id: "federation-trust-1",
  revision: 1,
  application_id: "application-1",
  application_subject_id: "application-subject-1",
  display_name: "CI workload",
  issuer: "https://issuer.example.test",
  jwks_uri: "https://issuer.example.test/jwks",
  audiences: ["genio-one-sts"],
  algorithms: ["RS256"],
  external_subject_id: "repo:acme/service:ref:main",
  required_claims: [{ name: "environment", value: "production" }],
  max_assertion_ttl_seconds: 600,
  state: "ACTIVE",
  created_by_subject_id: "person-owner",
  created_at: new Date(1_000_000),
}

const exchangeInput = {
  correlation_id: "federation-correlation-1",
  trust_id: "federation-trust-1",
  grant_type: "urn:ietf:params:oauth:grant-type:token-exchange" as const,
  subject_token_type: "urn:ietf:params:oauth:token-type:jwt" as const,
  requested_token_type: "urn:ietf:params:oauth:token-type:access_token" as const,
  subject_token: "external.assertion.signature",
  resource_id: "resource-api",
  capability_id: "incident.list",
  audience: "genio-one-product-api",
  scope: "genioone-invocation",
}

test("Federation Trust revisions are immutable and advance one active head", async () => {
  const sql = new FakeSql((text) => {
    if (text.includes("from genio_one_applications")) return [{ subject_id: "application-subject-1" }]
    if (text.includes("from genio_one_federation_trust_heads") && text.includes("for update")) return []
    if (text.includes("insert into genio_one_federation_trust_revisions")) return [trustRow]
    return []
  })
  const service = createPostgresFederationService({
    sql,
    idFactory: () => "1",
    now: () => 1_000,
  })

  const created = await service.createTrustRevision({
    tenantId: "tenant-acme",
    applicationId: "application-1",
    createdBySubjectId: "person-owner",
    value: {
      display_name: "CI workload",
      issuer: "https://issuer.example.test",
      jwks_uri: "https://issuer.example.test/jwks",
      audiences: ["genio-one-sts"],
      algorithms: ["RS256"],
      external_subject_id: "repo:acme/service:ref:main",
      required_claims: [{ name: "environment", value: "production" }],
      max_assertion_ttl_seconds: 600,
    },
  })

  assert.equal(created.application_subject_id, "application-subject-1")
  assert.equal(created.revision, 1)
  assert.ok(sql.calls.some(({ text }) => text.includes("insert into genio_one_federation_trust_revisions")))
  assert.ok(sql.calls.some(({ text }) => text.includes("insert into genio_one_federation_trust_heads")))
  assert.equal(sql.calls.some(({ text }) => text.includes("update genio_one_federation_trust_revisions")), false)
})

test("trusted workload exchange is bounded by the active Application credential and Entitlement", async () => {
  const sql = new FakeSql((text) => {
    if (text.includes("from genio_one_federation_exchange_events") && text.includes("select outcome")) return []
    if (text.includes("from genio_one_federation_trust_heads")) return [trustRow]
    if (text.includes("from genio_one_application_api_credentials")) {
      assert.match(text, /exists \([\s\S]*genio_one_model_entitlements/)
      return [{
        credential_id: "application-credential-2",
        generation: 2,
        oauth_client_id: "genio-app-2",
        oauth_audience: "genio-one-product-api",
        oauth_scope: "genioone-invocation",
      }]
    }
    return []
  })
  let brokerInput
  const service = createPostgresFederationService({
    sql,
    idFactory: () => "exchange-1",
    now: () => 1_000,
    verifier: {
      async verify({ trust }) {
        assert.equal(trust.application_subject_id, "application-subject-1")
        return {
          issuer: trust.issuer,
          subject: trust.external_subject_id,
          issued_at: 990,
          expires_at: 1_600,
          jti: "assertion-1",
          claims: { environment: "production" },
        }
      },
    },
    tokenBroker: {
      async mint(input) {
        brokerInput = input
        return {
          accessToken: "bounded-keycloak-token",
          tokenType: "Bearer",
          expiresIn: 300,
          scope: "genioone-invocation",
        }
      },
    },
  })

  const exchanged = await service.exchange({ tenantId: "tenant-acme", value: exchangeInput })

  assert.deepEqual(brokerInput, { clientId: "genio-app-2", scope: "genioone-invocation" })
  assert.equal(exchanged.application_subject_id, "application-subject-1")
  assert.equal(exchanged.credential_generation, 2)
  assert.equal(exchanged.access_token, "bounded-keycloak-token")
  const audit = sql.calls.find(({ text }) => text.includes("insert into genio_one_federation_exchange_events"))
  assert.ok(audit)
  assert.equal(audit.parameters.includes(exchangeInput.subject_token), false)
  assert.equal(audit.parameters.includes(exchanged.access_token), false)
  assert.equal(audit.parameters.includes("ISSUED"), true)
})

test("Federation Trust mismatch fails before credential brokering and records zero-upstream rejection", async () => {
  const sql = new FakeSql((text) => {
    if (text.includes("from genio_one_federation_exchange_events") && text.includes("select outcome")) return []
    if (text.includes("from genio_one_federation_trust_heads")) return [trustRow]
    return []
  })
  let brokerCalled = false
  const service = createPostgresFederationService({
    sql,
    idFactory: () => "exchange-rejected",
    now: () => 1_000,
    verifier: {
      async verify() {
        throw new PlatformApiError("FEDERATION_ASSERTION_TRUST_MISMATCH", 401)
      },
    },
    tokenBroker: {
      async mint() {
        brokerCalled = true
        throw new Error("must not run")
      },
    },
  })

  await assert.rejects(
    () => service.exchange({ tenantId: "tenant-acme", value: exchangeInput }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "FEDERATION_ASSERTION_TRUST_MISMATCH",
  )
  assert.equal(brokerCalled, false)
  assert.equal(sql.calls.some(({ text }) => text.includes("from genio_one_application_api_credentials")), false)
  const audit = sql.calls.find(({ text }) => text.includes("insert into genio_one_federation_exchange_events"))
  assert.ok(audit)
  assert.equal(audit.parameters.includes("REJECTED"), true)
  assert.equal(audit.parameters.includes("FEDERATION_ASSERTION_TRUST_MISMATCH"), true)
  assert.equal(audit.parameters.includes(exchangeInput.subject_token), false)
})

test("replayed workload assertion fails before entitlement lookup or token mint", async () => {
  const sql = new FakeSql((text) => {
    if (text.includes("from genio_one_federation_exchange_events") && text.includes("select outcome")) return []
    if (text.includes("from genio_one_federation_trust_heads")) return [trustRow]
    if (text.includes("insert into genio_one_federation_assertion_uses")) {
      throw Object.assign(new Error("duplicate"), {
        code: "23505",
        constraint: "genio_one_federation_assertion_uses_pkey",
      })
    }
    return []
  })
  let brokerCalled = false
  const service = createPostgresFederationService({
    sql,
    now: () => 1_000,
    verifier: {
      async verify() {
        return {
          issuer: trustRow.issuer,
          subject: trustRow.external_subject_id,
          issued_at: 990,
          expires_at: 1_600,
          jti: "replayed-assertion",
          claims: { environment: "production" },
        }
      },
    },
    tokenBroker: {
      async mint() {
        brokerCalled = true
        throw new Error("must not run")
      },
    },
  })

  await assert.rejects(
    () => service.exchange({ tenantId: "tenant-acme", value: exchangeInput }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "FEDERATION_ASSERTION_REPLAYED",
  )
  assert.equal(brokerCalled, false)
  assert.equal(sql.calls.some(({ text }) => text.includes("from genio_one_application_api_credentials")), false)
})
