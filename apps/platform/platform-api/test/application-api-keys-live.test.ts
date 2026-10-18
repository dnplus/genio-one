import type { LightMyRequestResponse } from "fastify"
import assert from "node:assert/strict"
import { generateKeyPairSync, randomUUID } from "node:crypto"
import test from "node:test"
import { createClient } from "redis"
import { GENIOONE_SCOPES, GENIOONE_SCOPE_VALUES, MANAGEMENT_SCOPES } from "@genioone/protocol/authorization-scopes"

import { createManagementApi } from "../src/app"
import { createPlatformModuleGraph } from "../src/capabilities/platform-modules-live"
import { createPostgresApplicationRegistry } from "../src/capabilities/applications/postgres"
import { applicationApiKeyHash, createApplicationApiKeyAuthenticator } from "../src/capabilities/applications/api-keys"
import { createPostgresIdentityDirectory } from "../src/capabilities/identity/postgres"
import { createPostgresOrganizationDirectory } from "../src/capabilities/organizations/postgres"
import { createDurableEd25519Signer } from "../src/capabilities/gateway-projection/signer"
import { createCanonicalPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/canonical"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"
import { PlatformApiError } from "../src/capabilities/errors"
import { runMigrations } from "../src/persistence/migration-runner"
import { createPostgresSqlAdapter } from "../src/persistence/sql-adapter"
import type { ResourceLifecycleReleasePublisher } from "../src/capabilities/resources/module"

const databaseUrl = process.env.GENIO_ONE_TEST_DATABASE_URL
const valkeyUrl = process.env.GENIO_ONE_TEST_VALKEY_URL

function signer(keyId: string) {
  const { privateKey } = generateKeyPairSync("ed25519")
  return createDurableEd25519Signer({ privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }), keyId })
}

async function clearTenant(sql: ReturnType<typeof createPostgresSqlAdapter>, tenantId: string) {
  await sql.transaction(async transaction => {
    for (const table of ["genio_one_application_api_credentials", "genio_one_model_entitlements", "genio_one_publications",
      "genio_one_resources", "genio_one_applications", "genio_one_organization_memberships", "genio_one_organization_membership_sources",
      "genio_one_organizations", "genio_one_external_identity_bindings", "genio_one_subject_roles", "genio_one_subjects"]) {
      await transaction.query(`delete from ${table} where tenant_id = $1`, [tenantId])
    }
  })
}

function hasCode(code: string) {
  return (error: unknown) => error instanceof PlatformApiError && error.code === code
}

test("live PostgreSQL Platform API keys persist only hashes and enforce the public lifecycle", { skip: !databaseUrl || !valkeyUrl }, async () => {
  const tenantId = `tenant-api-keys-live-${randomUUID()}`
  let at = Math.floor(Date.now() / 1000)
  const initial = at
  const sql = createPostgresSqlAdapter({ url: databaseUrl! })
  const valkey = createClient({ url: valkeyUrl! })
  let app: Awaited<ReturnType<typeof createManagementApi>> | undefined
  try {
    await runMigrations(sql)
    await valkey.connect()
    const modules = createPlatformModuleGraph({
      sql, now: () => at,
      valkey: { get: key => valkey.get(key), async set(key, value, options) { return (await valkey.set(key, value, options)) === "OK" ? "OK" : null }, eval: (script, options) => valkey.eval(script, options) },
      signingRoles: { projection: signer("key-projection"), runtimeCommand: signer("key-runtime"), policyArtifact: signer("key-policy"), releaseRoot: signer("key-release") },
      gatewayReleaseTtlSeconds: 600,
      mcpOAuthEncryptionKey: Buffer.alloc(32), mcpOAuthPublicOrigin: "http://127.0.0.1:58082", managementUiOrigin: "http://127.0.0.1:5173",
      platformOrigin: "http://127.0.0.1:58082", defaultGatewayId: "key-gateway",
      gatewayIdentityProvisioner: { async provision() { throw new Error("not used") }, async revoke() {} },
      applicationTokenBroker: { async mint() { throw new Error("not used") } }, workloadAssertionVerifier: { async verify() { throw new Error("not used") } },
    })
    await modules.identity.bootstrap({ tenantId, subjects: [{ subject_id: "person-key-admin", kind: "PERSON", role: "TENANT_ADMINISTRATOR" }] })
    const organization = await modules.organizations.create({ tenantId, display_name: "API key fixture owner" })
    app = await createManagementApi({ modules, resourceCatalog: modules.resources,
      principalAuthenticator: createCanonicalPrincipalAuthenticator({
        delegate: createApplicationApiKeyAuthenticator({ registry: modules.applications, delegate: createStaticPrincipalAuthenticator({ admin: {
          tenant_id: tenantId, subject_id: "person-key-admin", role: "TENANT_ADMINISTRATOR", client_id: "console",
          organization_ids: [], scopes: [...GENIOONE_SCOPE_VALUES],
        }, limited: {
          tenant_id: tenantId, subject_id: "person-key-admin", role: "TENANT_ADMINISTRATOR", client_id: "limited-third-party",
          organization_ids: [], scopes: [MANAGEMENT_SCOPES.credentialsWrite],
        }, reader: {
          tenant_id: tenantId, subject_id: "person-key-admin", role: "TENANT_ADMINISTRATOR", client_id: "consented-third-party",
          organization_ids: [], scopes: [MANAGEMENT_SCOPES.credentialsWrite, GENIOONE_SCOPES.read, MANAGEMENT_SCOPES.identityRead],
        } }) }), identity: modules.identity, organizations: modules.organizations,
      }),
    })
    const registered = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/applications`, headers: { authorization: "Bearer admin" },
      payload: { display_name: "Live key application", owner_organization_id: organization.organization_id } })
    assert.equal(registered.statusCode, 201, registered.body)
    const application = registered.json()
    const path = `/v1/tenants/${tenantId}/applications/${application.application_id}/api-credentials`
    for (const scope of [MANAGEMENT_SCOPES.auditRead, MANAGEMENT_SCOPES.systemRead]) {
      const denied: LightMyRequestResponse = await app.inject({ method: "POST", url: path, headers: { authorization: "Bearer limited" }, payload: {
        kind: "API_KEY", correlation_id: `denied-${scope}`, display_name: "Scope escalation", scopes: [scope], expires_at: initial + 3600,
      } })
      assert.equal(denied.statusCode, 403)
      assert.equal(denied.json().code, "INSUFFICIENT_SCOPE")
      assert.equal((await modules.applications.listCredentials({ tenantId, applicationId: application.application_id })).length, 0)
    }
    const issued = await app.inject({ method: "POST", url: path, headers: { authorization: "Bearer admin" }, payload: {
      kind: "API_KEY", correlation_id: "live-issue-1", display_name: "Live integration key",
      scopes: [GENIOONE_SCOPES.read, MANAGEMENT_SCOPES.identityRead], expires_at: initial + 3600,
    } })
    assert.equal(issued.statusCode, 201, issued.body)
    assert.equal(issued.headers["cache-control"], "no-store")
    const first = issued.json()
    const persisted = await sql.query(`select * from genio_one_application_api_credentials where tenant_id = $1 and credential_id = $2`, [tenantId, first.credential.credential_id])
    assert.equal(persisted.rows[0]!.api_key_hash, applicationApiKeyHash(first.api_key))
    assert.equal(persisted.rows[0]!.oauth_client_id, null)
    assert.equal(JSON.stringify(persisted.rows).includes(first.api_key), false)
    const catalog = (key: string) => app!.inject({ method: "GET", url: `/v1/tenants/${tenantId}/catalog`, headers: { authorization: `Bearer ${key}` } })
    const positive = await catalog(first.api_key)
    assert.equal(positive.statusCode, 200, positive.body)
    assert.equal(positive.json().subject_id, application.subject_id)
    const ownerDenied = await app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/identity`, headers: { authorization: `Bearer ${first.api_key}` } })
    assert.equal(ownerDenied.statusCode, 403)
    const repeated = await app.inject({ method: "POST", url: path, headers: { authorization: "Bearer admin" }, payload: {
      kind: "API_KEY", correlation_id: "live-issue-1", display_name: "Live integration key", scopes: [GENIOONE_SCOPES.read], expires_at: initial + 3600,
    } })
    assert.equal(repeated.statusCode, 409)
    assert.equal(repeated.json().code, "APPLICATION_CREDENTIAL_SECRET_ALREADY_DELIVERED")
    at += 10
    const deniedRotation = await app.inject({ method: "POST", url: `${path}/${first.credential.credential_id}/rotate`, headers: { authorization: "Bearer limited" },
      payload: { correlation_id: "live-rotate-1", grace_period_seconds: 2 } })
    assert.equal(deniedRotation.statusCode, 403)
    assert.equal(deniedRotation.json().code, "INSUFFICIENT_SCOPE")
    assert.equal((await modules.applications.listCredentials({ tenantId, applicationId: application.application_id })).length, 1)
    const rotated = await app.inject({ method: "POST", url: `${path}/${first.credential.credential_id}/rotate`, headers: { authorization: "Bearer reader" },
      payload: { correlation_id: "live-rotate-1", grace_period_seconds: 2 } })
    assert.equal(rotated.statusCode, 201, rotated.body)
    const second = rotated.json()
    assert.equal(second.credential.generation, 2)
    assert.equal(second.credential.expires_at, initial + 3600)
    assert.deepEqual(second.credential.scopes, first.credential.scopes)
    assert.equal((await catalog(first.api_key)).statusCode, 200)
    at += 2
    assert.equal((await catalog(first.api_key)).statusCode, 401)
    assert.equal((await catalog(second.api_key)).statusCode, 200)
    const inventory = await app.inject({ method: "GET", url: path, headers: { authorization: "Bearer admin" } })
    assert.equal(inventory.body.includes(first.api_key), false)
    assert.equal(inventory.body.includes(second.api_key), false)
    await modules.identity.suspend({ tenantId, subjectId: application.subject_id, suspendedBy: "person-key-admin", value: {} })
    assert.equal((await catalog(second.api_key)).statusCode, 401)
    await modules.identity.restore({ tenantId, subjectId: application.subject_id })
    assert.equal((await catalog(second.api_key)).statusCode, 200)
    const revoked = await app.inject({ method: "POST", url: `${path}/${second.credential.credential_id}/revoke`, headers: { authorization: "Bearer admin" }, payload: { correlation_id: "live-revoke-1" } })
    assert.equal(revoked.statusCode, 200, revoked.body)
    assert.equal((await catalog(second.api_key)).statusCode, 401)
    const after = await app.inject({ method: "POST", url: path, headers: { authorization: "Bearer admin" }, payload: {
      kind: "API_KEY", correlation_id: "live-issue-2", display_name: "Expiry key", scopes: [GENIOONE_SCOPES.read], expires_at: at + 1,
    } })
    assert.equal(after.statusCode, 201, after.body)
    const expiryKey = after.json().api_key
    at += 1
    assert.equal((await catalog(expiryKey)).statusCode, 401)
    console.info(JSON.stringify({ evidence: "application-api-key-live", tenant_id: tenantId, application_id: application.application_id,
      subject_id: application.subject_id, issued_credential_id: first.credential.credential_id, rotated_credential_id: second.credential.credential_id,
      hash_at_rest: true, secret_replay: false, scope_role_intersection: true, grace_expiry: true, subject_suspension: true, revoked: true, expired: true }))
  } finally {
    if (app) await app.close()
    await clearTenant(sql, tenantId)
    if (valkey.isOpen) await valkey.quit()
    await sql.end()
  }
})

test("live PostgreSQL resource keys reconcile issuance, rotation, revocation and Application suspension atomically", { skip: !databaseUrl }, async () => {
  const tenantId = `tenant-resource-keys-live-${randomUUID()}`
  const at = Math.floor(Date.now() / 1000)
  const sql = createPostgresSqlAdapter({ url: databaseUrl! })
  let failPublication = false
  let failGateway: string | null = null
  const deliveries: Array<{ gateway_id: string; credential_ids: string[]; suspended: boolean }> = []
  const publisher: ResourceLifecycleReleasePublisher = {
    async reconcileInTransaction({ transaction, gatewayId }) {
      const subject = await transaction.query<{ suspended: boolean }>(`select suspended_at is not null as suspended from genio_one_subjects where tenant_id = $1 and kind = 'APPLICATION'`, [tenantId])
      const bindings = await transaction.query<{ credential_id: string }>(
        `select credential.credential_id from genio_one_application_api_credentials credential
           join genio_one_subjects subject on subject.tenant_id = credential.tenant_id and subject.subject_id = credential.application_subject_id
          where credential.tenant_id = $1 and credential.resource_id is not null and credential.kind = 'API_KEY'
            and subject.suspended_at is null and credential.expires_at > now()
            and (credential.state = 'ACTIVE' or (credential.state = 'RETIRED' and credential.valid_until > now())) order by credential.credential_id`, [tenantId])
      deliveries.push({ gateway_id: gatewayId, credential_ids: bindings.rows.map(row => row.credential_id), suspended: subject.rows[0]!.suspended })
      if (failPublication || gatewayId === failGateway) throw new Error("publication fixture failure")
    },
  }
  try {
    await runMigrations(sql)
    const identity = createPostgresIdentityDirectory({ sql, releasePublisher: publisher })
    const organizations = createPostgresOrganizationDirectory({ sql })
    const registry = createPostgresApplicationRegistry({ sql, releasePublisher: publisher })
    await identity.bootstrap({ tenantId, subjects: [{ subject_id: "person-key-admin", kind: "PERSON", role: "TENANT_ADMINISTRATOR" }] })
    const organization = await organizations.create({ tenantId, display_name: "Resource key fixtures" })
    const application = await registry.register({ tenantId, registeredBySubjectId: "person-key-admin", value: { display_name: "Resource caller", owner_organization_id: organization.organization_id } })
    for (const [resourceId, kind, metadata] of [["resource-api", "API", null], ["resource-mcp", "MCP", null], ["resource-a2a", "API", { a2a: { operation: "SEND_MESSAGE" } }]] as const) {
      await sql.query(`insert into genio_one_resources (tenant_id, resource_id, display_name, kind, owner_organization_id, authentication_strategy, environment_id, version, lifecycle, capabilities, enforcement_point_id, api_metadata)
        values ($1, $2, $2, $3, $4, 'API_KEY', 'test', '1', 'PUBLISHED', $5::text::jsonb, 'key-gateway', $6::text::jsonb)`,
        [tenantId, resourceId, kind, organization.organization_id, JSON.stringify([{ capability_id: "call" }]), metadata === null ? null : JSON.stringify(metadata)])
      await sql.query(`insert into genio_one_publications (tenant_id, publication_id, resource_id, endpoint_revision, resource_revision, resource_digest, policy_revision, gateway_id, hostname, publication_state)
        values ($1, $2, $3, 1, 1, 'fixture', 1, 'key-gateway', 'key.example.test', 'PUBLISHED')`, [tenantId, `publication-${resourceId}`, resourceId])
      await sql.query(`insert into genio_one_model_entitlements (tenant_id, entitlement_id, subject_id, resource_id, capability_id, starts_at) values ($1, $2, $3, $4, 'call', to_timestamp($5))`,
        [tenantId, `entitlement-${resourceId}`, application.subject_id, resourceId, at - 1])
    }
    for (const [publicationId, gatewayId, revision, state] of [
      ["older-serving", "key-gateway-old", 2, "DEPRECATED"],
      ["duplicate-serving", "key-gateway-old", 3, "DEPRECATED"],
      ["retired", "key-gateway-retired", 4, "RETIRED"],
    ] as const) {
      await sql.query(`insert into genio_one_publications (tenant_id, publication_id, resource_id, endpoint_revision, resource_revision, resource_digest, policy_revision, gateway_id, hostname, publication_state)
        values ($1, $2, 'resource-api', $3, 1, 'fixture', 1, $4, 'key.example.test', $5)`, [tenantId, publicationId, revision, gatewayId, state])
    }
    const assertGateways = (start: number) => assert.deepEqual(deliveries.slice(start).map(delivery => delivery.gateway_id).sort(), ["key-gateway", "key-gateway-old"])
    const value = { kind: "API_KEY" as const, correlation_id: "resource-issue", display_name: "Resource key", scopes: [GENIOONE_SCOPES.invoke], expires_at: at + 3600,
      resource_id: "resource-api", capability_id: "call" }
    const first = await registry.issueApiKeyCredential({ issuerScopes: [...GENIOONE_SCOPE_VALUES], tenantId, applicationId: application.application_id, value })
    assertGateways(0)
    assert.equal(first.credential.kind, "API_KEY")
    assert.equal(await registry.authenticateApiKey({ tenantId, token: first.api_key! }), null)
    assert.deepEqual(deliveries.at(-1)!.credential_ids, [first.credential.credential_id])
    failGateway = "key-gateway-old"
    await assert.rejects(registry.rotateCredential({ issuerScopes: [...GENIOONE_SCOPE_VALUES], tenantId, applicationId: application.application_id, credentialId: first.credential.credential_id,
      value: { correlation_id: "resource-rotate", grace_period_seconds: 120 } }), /publication fixture failure/)
    const unchanged = await registry.listCredentials({ tenantId, applicationId: application.application_id })
    assert.equal(unchanged.length, 1)
    assert.equal(unchanged[0]!.state, "ACTIVE")
    failGateway = null
    const beforeRotate = deliveries.length
    const second = await registry.rotateCredential({ issuerScopes: [...GENIOONE_SCOPE_VALUES], tenantId, applicationId: application.application_id, credentialId: first.credential.credential_id,
      value: { correlation_id: "resource-rotate", grace_period_seconds: 120 } })
    assertGateways(beforeRotate)
    assert.equal(second.credential.expires_at, first.credential.expires_at)
    assert.equal(deliveries.at(-1)!.credential_ids.length, 2)
    const predecessor = await sql.query<{ valid_until: Date }>(`select valid_until from genio_one_application_api_credentials where tenant_id = $1 and credential_id = $2`, [tenantId, first.credential.credential_id])
    assert.ok(Math.floor(predecessor.rows[0]!.valid_until.getTime() / 1000) <= at + 121)
    await identity.suspend({ tenantId, subjectId: application.subject_id, suspendedBy: "person-key-admin", value: {} })
    assert.equal(deliveries.at(-1)!.suspended, true)
    assert.deepEqual(deliveries.at(-1)!.credential_ids, [])
    await identity.restore({ tenantId, subjectId: application.subject_id })
    assert.equal(deliveries.at(-1)!.credential_ids.length, 2)
    failPublication = true
    await assert.rejects(identity.suspend({ tenantId, subjectId: application.subject_id, suspendedBy: "person-key-admin", value: {} }), /publication fixture failure/)
    assert.equal((await identity.authorizationForSubject({ tenantId, subjectId: application.subject_id })).suspended, false)
    failPublication = false
    failGateway = "key-gateway-old"
    await assert.rejects(registry.revokeCredential({ tenantId, applicationId: application.application_id, credentialId: second.credential.credential_id, correlationId: "resource-revoke" }), /publication fixture failure/)
    assert.equal((await registry.listCredentials({ tenantId, applicationId: application.application_id })).find(item => item.credential_id === second.credential.credential_id)!.state, "ACTIVE")
    failGateway = null
    const beforeRevoke = deliveries.length
    await registry.revokeCredential({ tenantId, applicationId: application.application_id, credentialId: second.credential.credential_id, correlationId: "resource-revoke" })
    assertGateways(beforeRevoke)
    const beforeRepeat = deliveries.length
    await registry.revokeCredential({ tenantId, applicationId: application.application_id, credentialId: second.credential.credential_id, correlationId: "resource-revoke-repeat" })
    assert.equal(deliveries.length, beforeRepeat)
    assert.deepEqual(deliveries.at(-1)!.credential_ids, [first.credential.credential_id])
    for (const resourceId of ["resource-mcp", "resource-a2a"]) {
      await assert.rejects(registry.issueApiKeyCredential({ issuerScopes: [...GENIOONE_SCOPE_VALUES], tenantId, applicationId: application.application_id, value: { ...value, correlation_id: resourceId, resource_id: resourceId } }), hasCode("API_KEY_RESOURCE_UNSUPPORTED"))
    }
    const stored = await sql.query(`select * from genio_one_application_api_credentials where tenant_id = $1`, [tenantId])
    assert.equal(JSON.stringify(stored.rows).includes(first.api_key!), false)
    assert.equal(JSON.stringify(stored.rows).includes(second.api_key!), false)
    console.info(JSON.stringify({ evidence: "resource-api-key-postgres", tenant_id: tenantId, subject_id: application.subject_id,
      issued_credential_id: first.credential.credential_id, rotated_credential_id: second.credential.credential_id,
      reconcile_calls: deliveries.length, suspension_excludes_keys: true, failed_reconcile_rolls_back_subject: true,
      platform_auth_rejects_resource_key: true, unsupported_mcp_a2a_rejected: true }))
  } finally { await clearTenant(sql, tenantId); await sql.end() }
})

test("PostgreSQL OAuth credential lifecycle fans out to every serving gateway with transactional rollback", { skip: !databaseUrl }, async () => {
  const tenantId = `tenant-oauth-fanout-${randomUUID()}`
  const schema = `oauth_fanout_${randomUUID().replaceAll("-", "")}`
  const sql = createPostgresSqlAdapter({ url: databaseUrl! })
  let at = Math.floor(Date.now() / 1000)
  let failGateway: string | null = "oauth-gateway-z"
  const published: string[] = []
  const provisioned: string[] = []
  const providerRevoked: string[] = []
  const publisher: ResourceLifecycleReleasePublisher = {
    async reconcileInTransaction({ transaction, gatewayId }) {
      const bindings = await transaction.query<{ credential_id: string }>(
        `select credential.credential_id from genio_one_application_api_credentials credential
           join genio_one_external_identity_bindings binding
             on binding.tenant_id = credential.tenant_id and binding.provider_id = credential.identity_provider_id
            and binding.external_subject_id = credential.external_subject_id and binding.subject_id = credential.application_subject_id
          where credential.tenant_id = $1 and credential.resource_id = 'resource-oauth' and credential.kind = 'OAUTH2'
            and (credential.state = 'ACTIVE' or (credential.state = 'RETIRED' and credential.valid_until > to_timestamp($2)))
          order by credential.credential_id`, [tenantId, at])
      await transaction.query(`insert into ${schema}.releases as release (gateway_id, credential_ids, revision) values ($1, $2::text::jsonb, 1)
        on conflict (gateway_id) do update set credential_ids = excluded.credential_ids, revision = release.revision + 1`,
        [gatewayId, JSON.stringify(bindings.rows.map(row => row.credential_id))])
      published.push(gatewayId)
      if (gatewayId === failGateway) throw new Error("OAuth publication fixture failure")
    },
  }
  const releases = async () => (await sql.query<{ gateway_id: string; credential_ids: string[]; revision: number }>(
    `select gateway_id, credential_ids, revision from ${schema}.releases order by gateway_id`)).rows
  const assertGateways = (start: number) => assert.deepEqual(published.slice(start), ["oauth-gateway-a", "oauth-gateway-z"])
  try {
    await runMigrations(sql)
    await sql.query(`create schema ${schema}`)
    await sql.query(`create table ${schema}.releases (gateway_id text primary key, credential_ids jsonb not null, revision integer not null)`)
    const identity = createPostgresIdentityDirectory({ sql })
    const organizations = createPostgresOrganizationDirectory({ sql })
    const registry = createPostgresApplicationRegistry({ sql, now: () => at, releasePublisher: publisher, oauthProvisioner: {
      async provision(input) {
        provisioned.push(input.clientId)
        return { clientId: input.clientId, clientSecret: "oauth-fixture-secret", tokenEndpoint: "https://identity.test/token",
          issuer: input.issuer, externalSubjectId: `fixture-${input.clientId}`, identityProviderId: "oauth-fixture" }
      },
      async revoke({ clientId }) { providerRevoked.push(clientId) },
    } })
    await identity.bootstrap({ tenantId, subjects: [{ subject_id: "oauth-fixture-admin", kind: "PERSON", role: "TENANT_ADMINISTRATOR" }] })
    const organization = await organizations.create({ tenantId, display_name: "OAuth fanout fixture" })
    const application = await registry.register({ tenantId, registeredBySubjectId: "oauth-fixture-admin",
      value: { display_name: "OAuth fixture caller", owner_organization_id: organization.organization_id } })
    await sql.query(`insert into genio_one_resources (tenant_id, resource_id, display_name, kind, owner_organization_id, authentication_strategy,
      environment_id, version, lifecycle, capabilities, enforcement_point_id, api_metadata)
      values ($1, 'resource-oauth', 'OAuth fixture', 'API', $2, 'OAUTH', 'test', '1', 'PUBLISHED', '[{"capability_id":"call"}]', 'oauth-gateway-a', $3::text::jsonb)`,
      [tenantId, organization.organization_id, JSON.stringify({ inbound_security: { type: "OAUTH2", issuer: "https://identity.test",
        audience: "oauth-fixture", scope: `${GENIOONE_SCOPES.read} records.lookup` } })])
    for (const [publicationId, gatewayId, revision, state] of [
      ["oauth-primary", "oauth-gateway-a", 1, "PUBLISHED"], ["oauth-older", "oauth-gateway-z", 2, "DEPRECATED"],
      ["oauth-duplicate", "oauth-gateway-z", 3, "DEPRECATED"], ["oauth-retired", "oauth-gateway-retired", 4, "RETIRED"],
      ["oauth-draft", "oauth-gateway-draft", 5, "DRAFT"],
    ] as const) {
      await sql.query(`insert into genio_one_publications (tenant_id, publication_id, resource_id, endpoint_revision, resource_revision, resource_digest,
        policy_revision, gateway_id, hostname, publication_state) values ($1, $2, 'resource-oauth', $3, 1, 'fixture', 1, $4, 'oauth.example.test', $5)`,
        [tenantId, publicationId, revision, gatewayId, state])
    }
    await sql.query(`insert into genio_one_model_entitlements (tenant_id, entitlement_id, subject_id, resource_id, capability_id, starts_at)
      values ($1, 'oauth-entitlement', $2, 'resource-oauth', 'call', to_timestamp($3))`, [tenantId, application.subject_id, at - 1])
    const context = { tenantId, applicationId: application.application_id, issuerScopes: [GENIOONE_SCOPES.read] }
    const value = { correlation_id: "oauth-issue", resource_id: "resource-oauth", capability_id: "call" }
    await assert.rejects(registry.issueOAuthCredential({ ...context, issuerScopes: [MANAGEMENT_SCOPES.credentialsWrite], value }), hasCode("INSUFFICIENT_SCOPE"))
    assert.equal(provisioned.length, 0)
    assert.equal((await registry.listCredentials(context)).length, 0)
    await assert.rejects(registry.issueOAuthCredential({ ...context, value: { ...value, correlation_id: "oauth-issue-failed" } }), /OAuth publication fixture failure/)
    assertGateways(0)
    assert.deepEqual(await releases(), [])
    assert.deepEqual((await registry.listCredentials(context)).map(row => row.state), ["REVOKED"])
    assert.equal((await sql.query(`select 1 from genio_one_external_identity_bindings where tenant_id = $1`, [tenantId])).rows.length, 0)
    assert.deepEqual(providerRevoked, [provisioned[0]])
    failGateway = null
    const beforeIssue = published.length
    const first = await registry.issueOAuthCredential({ ...context, value })
    assertGateways(beforeIssue)
    assert.equal(first.credential.state, "ACTIVE")
    assert.equal(first.credential.oauth_scope, `${GENIOONE_SCOPES.read} records.lookup`)
    const issuedReleases = await releases()
    assert.deepEqual(issuedReleases.map(row => row.credential_ids), [[first.credential.credential_id], [first.credential.credential_id]])
    const rotation = { ...context, credentialId: first.credential.credential_id, value: { correlation_id: "oauth-rotate", grace_period_seconds: 10 } }
    const providerCount = provisioned.length
    await assert.rejects(registry.rotateCredential({ ...rotation, issuerScopes: [MANAGEMENT_SCOPES.credentialsWrite] }), hasCode("INSUFFICIENT_SCOPE"))
    assert.equal(provisioned.length, providerCount)
    assert.deepEqual(await releases(), issuedReleases)
    failGateway = "oauth-gateway-z"
    await assert.rejects(registry.rotateCredential({ ...rotation, value: { ...rotation.value, correlation_id: "oauth-rotate-failed" } }), /OAuth publication fixture failure/)
    const afterFailedRotation = (await registry.listCredentials(context)).find(row => row.credential_id === first.credential.credential_id)
    assert.equal(afterFailedRotation?.state, "ACTIVE")
    assert.equal(afterFailedRotation?.valid_until, null)
    assert.deepEqual(await releases(), issuedReleases)
    assert.equal((await sql.query(`select 1 from genio_one_external_identity_bindings where tenant_id = $1`, [tenantId])).rows.length, 1)
    failGateway = null
    const beforeRotate = published.length
    const second = await registry.rotateCredential(rotation)
    assertGateways(beforeRotate)
    const activeIds = [first.credential.credential_id, second.credential.credential_id].sort()
    const rotatedReleases = await releases()
    assert.deepEqual(rotatedReleases.map(row => row.credential_ids), [activeIds, activeIds])
    const predecessor = (await registry.listCredentials(context)).find(row => row.credential_id === first.credential.credential_id)
    assert.equal(predecessor?.state, "RETIRED")
    assert.equal(predecessor?.valid_until, at + 10)
    failGateway = "oauth-gateway-z"
    const revocation = { tenantId, applicationId: application.application_id, credentialId: second.credential.credential_id, correlationId: "oauth-revoke" }
    await assert.rejects(registry.revokeCredential(revocation), /OAuth publication fixture failure/)
    assert.equal((await registry.listCredentials(context)).find(row => row.credential_id === second.credential.credential_id)?.state, "ACTIVE")
    assert.deepEqual(await releases(), rotatedReleases)
    assert.equal((await sql.query(`select 1 from genio_one_external_identity_bindings where tenant_id = $1`, [tenantId])).rows.length, 2)
    failGateway = null
    const beforeRevoke = published.length
    assert.equal((await registry.revokeCredential(revocation)).state, "REVOKED")
    assertGateways(beforeRevoke)
    const revokedReleases = await releases()
    assert.deepEqual(revokedReleases.map(row => row.credential_ids), [[first.credential.credential_id], [first.credential.credential_id]])
    const beforeRepeatedRevoke = published.length
    await registry.revokeCredential(revocation)
    assert.equal(published.length, beforeRepeatedRevoke)
    at += 10
    failGateway = "oauth-gateway-z"
    await assert.rejects(registry.retireExpiredCredentials(), /OAuth publication fixture failure/)
    assert.deepEqual(await releases(), revokedReleases)
    assert.equal((await sql.query(`select 1 from genio_one_external_identity_bindings where tenant_id = $1`, [tenantId])).rows.length, 1)
    failGateway = null
    const beforeRetire = published.length
    assert.equal(await registry.retireExpiredCredentials(), 1)
    assertGateways(beforeRetire)
    assert.deepEqual((await releases()).map(row => row.credential_ids), [[], []])
    assert.equal((await sql.query(`select 1 from genio_one_external_identity_bindings where tenant_id = $1`, [tenantId])).rows.length, 0)
    const beforeRepeat = published.length
    assert.equal(await registry.retireExpiredCredentials(), 0)
    assert.equal(published.length, beforeRepeat)
    const persisted = await sql.query(`select * from genio_one_application_api_credentials where tenant_id = $1`, [tenantId])
    assert.equal(JSON.stringify(persisted.rows).includes("oauth-fixture-secret"), false)
    console.info(JSON.stringify({ evidence: "oauth-postgres-fanout-fixture", all_serving_gateways: true, duplicate_gateway_deduplicated: true,
      nonserving_gateways_excluded: true, issuer_scope_ceiling: true, issue_rotate_revoke_retire_rollback: true, secret_not_persisted: true }))
  } finally {
    await clearTenant(sql, tenantId)
    await sql.query(`drop schema if exists ${schema} cascade`)
    await sql.end()
  }
})
