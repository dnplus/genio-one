import assert from "node:assert/strict"
import test from "node:test"

import { createPostgresApplicationRegistry } from "../src/capabilities/applications/postgres"
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

test("Application OAuth credential binds the active Publication gateway and canonical external identity", async () => {
  const credentialRow = {
    credential_id: "application-credential-1",
    application_id: "application-1",
    application_subject_id: "application-subject-1",
    resource_id: "resource-api",
    capability_id: "incident.list",
    generation: 1,
    kind: "OAUTH2",
    oauth_client_id: "genio-app-1",
    oauth_issuer: "http://keycloak.test/realms/genio-one",
    oauth_audience: "genio-one-product-api",
    oauth_scope: "genioone-invocation",
    identity_provider_id: "keycloak-local",
    external_subject_id: "service-account-1",
    state: "ACTIVE",
    created_at: new Date(1_000_000),
    activated_at: new Date(1_000_000),
    valid_until: null,
    revoked_at: null,
  }
  const sql = new FakeSql((text) => {
    if (text.includes("from genio_one_applications application")) {
      assert.match(text, /join genio_one_publications publication/)
      assert.doesNotMatch(text, /enforcement_point_id/)
      return [{
        application_subject_id: "application-subject-1",
        api_metadata: {
          inbound_security: {
            type: "OAUTH2",
            issuer: "http://keycloak.test/realms/genio-one",
            audience: "genio-one-product-api",
            scope: "genioone-invocation",
          },
        },
        gateway_id: "gateway-api",
      }]
    }
    if (text.includes("select credential_id")) return []
    if (text.includes("select coalesce(max(generation)")) return [{ next_generation: 1 }]
    if (text.includes("select subject_id from genio_one_external_identity_bindings")) {
      return [{ subject_id: "application-subject-1" }]
    }
    if (text.includes("update genio_one_application_api_credentials") && text.includes("returning")) {
      return [credentialRow]
    }
    return []
  })
  const published: string[] = []
  const registry = createPostgresApplicationRegistry({
    sql,
    idFactory: () => "1",
    now: () => 1_000,
    oauthProvisioner: {
      async provision(input) {
        return {
          clientId: input.clientId,
          clientSecret: "one-time-secret",
          tokenEndpoint: "http://keycloak.test/realms/genio-one/protocol/openid-connect/token",
          issuer: input.issuer,
          externalSubjectId: "service-account-1",
          identityProviderId: "keycloak-local",
        }
      },
      async revoke() {},
    },
    releasePublisher: {
      async reconcileInTransaction({ gatewayId }) {
        published.push(gatewayId)
      },
    },
  })

  const created = await registry.issueOAuthCredential({
    tenantId: "tenant-acme",
    applicationId: "application-1",
    value: {
      correlation_id: "credential-correlation-1",
      resource_id: "resource-api",
      capability_id: "incident.list",
    },
  })

  assert.equal(created.credential.state, "ACTIVE")
  assert.equal(created.credential_delivery, "ONE_TIME")
  assert.equal(created.oauth_client_secret, "one-time-secret")
  assert.deepEqual(published, ["gateway-api"])
  assert.ok(sql.calls.some(({ text }) => text.includes("insert into genio_one_external_identity_bindings")))
  assert.equal(sql.calls.some(({ text }) => text.includes("genio_one_subject_external_identities")), false)
})

test("Application OAuth rotation activates one successor and bounds the predecessor grace period", async () => {
  const predecessor = {
    credential_id: "application-credential-1",
    application_id: "application-1",
    application_subject_id: "application-subject-1",
    resource_id: "resource-api",
    capability_id: "incident.list",
    generation: 1,
    kind: "OAUTH2",
    oauth_client_id: "genio-app-old",
    oauth_issuer: "http://keycloak.test/realms/genio-one",
    oauth_audience: "genio-one-product-api",
    oauth_scope: "genioone-invocation",
    identity_provider_id: "keycloak-local",
    external_subject_id: "service-account-old",
    state: "ACTIVE",
    created_at: new Date(1_000_000),
    activated_at: new Date(1_000_000),
    valid_until: null,
    revoked_at: null,
  }
  const successor = {
    ...predecessor,
    credential_id: "application-credential-2",
    generation: 2,
    oauth_client_id: "genio-app-new",
    external_subject_id: "service-account-new",
    state: "ACTIVE",
  }
  const sql = new FakeSql((text) => {
    if (text.includes("operation_correlation_id =")) return []
    if (text.includes("resource.api_metadata") && text.includes("credential.credential_id")) {
      return [{
        ...predecessor,
        api_metadata: {
          inbound_security: {
            type: "OAUTH2",
            issuer: predecessor.oauth_issuer,
            audience: predecessor.oauth_audience,
            scope: predecessor.oauth_scope,
          },
        },
        gateway_id: "gateway-api",
      }]
    }
    if (text.includes("select coalesce(max(generation)")) return [{ next_generation: 2 }]
    if (text.includes("select subject_id from genio_one_external_identity_bindings")) {
      return [{ subject_id: predecessor.application_subject_id }]
    }
    if (text.includes("set state = 'RETIRED'")) return [{ credential_id: predecessor.credential_id }]
    if (text.includes("set state = 'ACTIVE'") && text.includes("returning")) return [successor]
    return []
  })
  const published: string[] = []
  const registry = createPostgresApplicationRegistry({
    sql,
    idFactory: () => "2",
    now: () => 1_000,
    oauthProvisioner: {
      async provision(input) {
        return {
          clientId: "genio-app-new",
          clientSecret: "successor-secret",
          tokenEndpoint: "http://keycloak.test/realms/genio-one/protocol/openid-connect/token",
          issuer: input.issuer,
          externalSubjectId: "service-account-new",
          identityProviderId: "keycloak-local",
        }
      },
      async revoke() {},
    },
    releasePublisher: {
      async reconcileInTransaction({ gatewayId }) {
        published.push(gatewayId)
      },
    },
  })

  const created = await registry.rotateCredential({
    tenantId: "tenant-acme",
    applicationId: "application-1",
    credentialId: predecessor.credential_id,
    value: {
      correlation_id: "credential-rotation-1",
      grace_period_seconds: 60,
    },
  })

  assert.equal(created.credential.generation, 2)
  assert.equal(created.credential.application_subject_id, predecessor.application_subject_id)
  assert.equal(created.oauth_client_secret, "successor-secret")
  assert.equal(created.credential_delivery, "ONE_TIME")
  assert.deepEqual(published, ["gateway-api"])
  const retirement = sql.calls.find(({ text }) => text.includes("set state = 'RETIRED'"))
  assert.deepEqual(retirement?.parameters, [
    "tenant-acme",
    "application-1",
    predecessor.credential_id,
    1_060,
  ])
  const retirementIndex = sql.calls.findIndex(({ text }) => text.includes("set state = 'RETIRED'"))
  const activationIndex = sql.calls.findIndex(({ text }) => text.includes("set state = 'ACTIVE'") && text.includes("returning"))
  assert.ok(retirementIndex >= 0 && retirementIndex < activationIndex)
  assert.equal(JSON.stringify(sql.calls).includes("successor-secret"), false)
})

test("credential revoke requires the signed release publisher before provider mutation", async () => {
  let providerRevoked = false
  const registry = createPostgresApplicationRegistry({
    sql: new FakeSql(() => []),
    oauthProvisioner: {
      async provision() {
        throw new Error("not used")
      },
      async revoke() {
        providerRevoked = true
      },
    },
  })
  await assert.rejects(
    registry.revokeCredential({
      tenantId: "tenant-acme",
      applicationId: "application-1",
      credentialId: "application-credential-1",
      correlationId: "credential-revoke-1",
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "APPLICATION_CREDENTIAL_RELEASE_PUBLISHER_UNAVAILABLE",
  )
  assert.equal(providerRevoked, false)
})

test("expired retired Application credentials are revoked and detached within tenant scope", async () => {
  const sql = new FakeSql((text) => {
    if (text.includes("where state = 'RETIRED'")) {
      return [{
        tenant_id: "tenant-acme",
        credential_id: "application-credential-1",
        application_subject_id: "application-subject-1",
        oauth_client_id: "genio-app-old",
        identity_provider_id: "keycloak-local",
        external_subject_id: "service-account-old",
      }]
    }
    if (text.includes("set identity_provider_id = null")) {
      return [{ credential_id: "application-credential-1" }]
    }
    return []
  })
  const revoked: string[] = []
  const registry = createPostgresApplicationRegistry({
    sql,
    now: () => 2_000,
    oauthProvisioner: {
      async provision() {
        throw new Error("not used")
      },
      async revoke({ clientId }) {
        revoked.push(clientId)
      },
    },
  })

  assert.equal(await registry.retireExpiredCredentials(), 1)
  assert.deepEqual(revoked, ["genio-app-old"])
  const bindingDelete = sql.calls.find(({ text }) => text.includes("delete from genio_one_external_identity_bindings"))
  assert.deepEqual(bindingDelete?.parameters, [
    "tenant-acme",
    "keycloak-local",
    "service-account-old",
    "application-subject-1",
  ])
  const credentialUpdate = sql.calls.find(({ text }) => text.includes("set identity_provider_id = null"))
  assert.deepEqual(credentialUpdate?.parameters, ["tenant-acme", "application-credential-1", 2_000])
})
