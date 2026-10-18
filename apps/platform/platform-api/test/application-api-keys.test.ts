import assert from "node:assert/strict"
import test from "node:test"
import { GENIOONE_SCOPES, GENIOONE_SCOPE_VALUES, MANAGEMENT_SCOPES } from "@genioone/protocol/authorization-scopes"

import { createManagementApi } from "../src/app"
import { PlatformApiError } from "../src/capabilities/errors"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createCanonicalPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/canonical"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"
import {
  applicationApiKeyHash,
  assertApplicationCredentialScopeCeiling,
  createApplicationApiKeyAuthenticator,
  createApplicationApiKeyMaterial,
  validateApplicationApiKeyInput,
} from "../src/capabilities/applications/api-keys"
import type { ApplicationApiCredentialCreation, IssueApplicationApiKeyCredentialInput } from "../src/capabilities/applications/contract"

import type { ApplicationRegistry } from "../src/capabilities/applications/module"

const tenantId = "tenant-key-test"

async function fixture(issuers?: Pick<ApplicationRegistry, "issueApiKeyCredential" | "issueOAuthCredential">) {
  let at = 1_000
  const modules = createInMemoryPlatformModules({ now: () => at })
  await modules.identity.bootstrap({ tenantId, subjects: [{ subject_id: "person-admin", kind: "PERSON", role: "TENANT_ADMINISTRATOR" }] })
  const organization = await modules.organizations.create({ tenantId, display_name: "Key owner" })
  const application = await modules.applications.register({ tenantId, registeredBySubjectId: "person-admin",
    value: { display_name: "Key application", owner_organization_id: organization.organization_id } })
  if (issuers) Object.assign(modules.applications, issuers)
  const app = await createManagementApi({
    modules, resourceCatalog: modules.resources,
    principalAuthenticator: createCanonicalPrincipalAuthenticator({
      delegate: createApplicationApiKeyAuthenticator({ registry: modules.applications, delegate: createStaticPrincipalAuthenticator({ admin: {
        tenant_id: tenantId, subject_id: "person-admin", role: "TENANT_ADMINISTRATOR", client_id: "console",
        organization_ids: [], scopes: [...GENIOONE_SCOPE_VALUES],
      }, limited: {
        tenant_id: tenantId, subject_id: "person-admin", role: "TENANT_ADMINISTRATOR", client_id: "third-party",
        organization_ids: [], scopes: [MANAGEMENT_SCOPES.credentialsWrite],
      }, reader: {
        tenant_id: tenantId, subject_id: "person-admin", role: "TENANT_ADMINISTRATOR", client_id: "third-party",
        organization_ids: [], scopes: [MANAGEMENT_SCOPES.credentialsWrite, GENIOONE_SCOPES.read],
      } }) }),
      identity: modules.identity, organizations: modules.organizations,
    }),
  })
  const credentialPath = `/v1/tenants/${tenantId}/applications/${application.application_id}/api-credentials`
  return { app, modules, application, organization, credentialPath, time(value: number) { at = value } }
}

function input(overrides: Partial<IssueApplicationApiKeyCredentialInput> = {}): IssueApplicationApiKeyCredentialInput {
  return { kind: "API_KEY", correlation_id: "issue-1", display_name: "Automation", scopes: [GENIOONE_SCOPES.read], expires_at: 2_000, ...overrides }
}

function hasCode(code: string) {
  return (error: unknown) => error instanceof PlatformApiError && error.code === code
}

test("API keys use high entropy one-time secrets and reject invalid scope, target and expiry ceilings", () => {
  const first = createApplicationApiKeyMaterial()
  const second = createApplicationApiKeyMaterial()
  assert.match(first.secret, /^genio_app_[A-Za-z0-9_-]{43}$/)
  assert.notEqual(first.secret, second.secret)
  assert.equal(Buffer.from(first.secret.slice("genio_app_".length), "base64url").length, 32)
  assert.equal(applicationApiKeyHash(first.secret), first.hash)
  assert.equal(applicationApiKeyHash("genio_app_short"), null)
  for (const scopes of [[], ["unknown"], ["genioone-management"], ["genioone-gateway-runtime"], [GENIOONE_SCOPES.invoke], [GENIOONE_SCOPES.read, GENIOONE_SCOPES.read]]) {
    assert.throws(() => validateApplicationApiKeyInput(input({ scopes }), 1_000), hasCode("API_KEY_SCOPE_INVALID"))
  }
  assert.throws(() => validateApplicationApiKeyInput(input({ resource_id: "resource-1" }), 1_000), hasCode("API_KEY_TARGET_INVALID"))
  assert.throws(() => validateApplicationApiKeyInput(input({ resource_id: "resource-1", capability_id: "capability-1", scopes: [MANAGEMENT_SCOPES.resourcesWrite] }), 1_000), hasCode("API_KEY_SCOPE_INVALID"))
  for (const expires_at of [1_000, 999, 1_000 + 365 * 86400 + 1]) {
    assert.throws(() => validateApplicationApiKeyInput(input({ expires_at }), 1_000), hasCode("API_KEY_EXPIRY_INVALID"))
  }
})

test("public Platform API key issuance authenticates the Application and never replays its secret", async () => {
  const f = await fixture()
  try {
    const issued = await f.app.inject({ method: "POST", url: f.credentialPath, headers: { authorization: "Bearer admin" }, payload: input() })
    assert.equal(issued.statusCode, 201, issued.body)
    assert.equal(issued.headers["cache-control"], "no-store")
    const created = issued.json()
    assert.equal(created.oauth_client_secret, null)
    assert.equal(created.oauth_token_endpoint, null)
    assert.equal(created.credential.application_subject_id, f.application.subject_id)
    assert.equal(created.credential.resource_id, null)
    const headers = { authorization: `Bearer ${created.api_key}` }
    const catalog = await f.app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/catalog`, headers })
    assert.equal(catalog.statusCode, 200, catalog.body)
    assert.equal(catalog.json().subject_id, f.application.subject_id)
    const principal = await f.modules.applications.authenticateApiKey({ tenantId, token: created.api_key })
    assert.equal(principal!.client_id, created.credential.credential_id)
    const insufficient = await f.app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/identity`, headers })
    assert.equal(insufficient.statusCode, 403)
    assert.equal(insufficient.json().code, "INSUFFICIENT_SCOPE")
    const inventory = await f.app.inject({ method: "GET", url: f.credentialPath, headers: { authorization: "Bearer admin" } })
    assert.equal(inventory.statusCode, 200)
    assert.equal(inventory.body.includes(created.api_key), false)
    assert.equal(inventory.body.includes(applicationApiKeyHash(created.api_key)!), false)
    assert.equal(inventory.json()[0].key_prefix, created.credential.key_prefix)
    const repeated = await f.app.inject({ method: "POST", url: f.credentialPath, headers: { authorization: "Bearer admin" }, payload: input() })
    assert.equal(repeated.statusCode, 409)
    assert.equal(repeated.json().code, "APPLICATION_CREDENTIAL_SECRET_ALREADY_DELIVERED")
    assert.equal(repeated.body.includes(created.api_key), false)
    const crossTenant = await f.app.inject({ method: "GET", url: "/v1/tenants/other/catalog", headers })
    assert.equal(crossTenant.statusCode, 401)
    const forged = await f.app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/catalog`, headers: { authorization: `Bearer genio_app_${"x".repeat(43)}` } })
    assert.equal(forged.statusCode, 401)
  } finally { await f.app.close() }
})

test("scope ceiling intersects current Application organization rights without owner impersonation", async () => {
  const f = await fixture()
  try {
    const issued = await f.app.inject({ method: "POST", url: f.credentialPath, headers: { authorization: "Bearer admin" },
      payload: input({ scopes: [MANAGEMENT_SCOPES.identityRead, MANAGEMENT_SCOPES.identityWrite] }) })
    assert.equal(issued.statusCode, 201)
    const headers = { authorization: `Bearer ${issued.json().api_key}` }
    const identityPath = `/v1/tenants/${tenantId}/identity`
    assert.equal((await f.app.inject({ method: "GET", url: identityPath, headers })).statusCode, 403)
    const owner = await f.modules.organizations.get({ tenantId, organizationId: f.organization.organization_id })
    const member = { ...owner, member_subject_ids: [f.application.subject_id], organization_administrator_subject_ids: [f.application.subject_id] }
    await f.modules.organizations.update({ tenantId, organizationId: owner.organization_id, value: member })
    const allowed = await f.app.inject({ method: "GET", url: identityPath, headers })
    assert.equal(allowed.statusCode, 200, allowed.body)
    assert.deepEqual(allowed.json().subjects.map((subject: { subject_id: string }) => subject.subject_id), [f.application.subject_id])
    await f.modules.organizations.update({ tenantId, organizationId: owner.organization_id,
      value: { ...member, organization_administrator_subject_ids: [] } })
    assert.equal((await f.app.inject({ method: "GET", url: identityPath, headers })).statusCode, 403)
    const noReadScope = await f.app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/catalog`, headers })
    assert.equal(noReadScope.statusCode, 403)
    assert.equal(noReadScope.json().code, "INSUFFICIENT_SCOPE")
  } finally { await f.app.close() }
})

test("rotation bounds overlap, preserves expiry and checks revocation and Subject suspension on every request", async () => {
  const f = await fixture()
  const catalogPath = `/v1/tenants/${tenantId}/catalog`
  try {
    const issued = await f.app.inject({ method: "POST", url: f.credentialPath, headers: { authorization: "Bearer admin" }, payload: input() })
    const first = issued.json()
    const read = (secret: string) => f.app.inject({ method: "GET", url: catalogPath, headers: { authorization: `Bearer ${secret}` } })
    f.time(1_010)
    const rotated = await f.app.inject({ method: "POST", url: `${f.credentialPath}/${first.credential.credential_id}/rotate`,
      headers: { authorization: "Bearer admin" }, payload: { correlation_id: "rotate-1", grace_period_seconds: 60 } })
    assert.equal(rotated.statusCode, 201, rotated.body)
    assert.equal(rotated.headers["cache-control"], "no-store")
    const second = rotated.json()
    assert.notEqual(second.api_key, first.api_key)
    assert.equal(second.credential.generation, 2)
    assert.equal(second.credential.expires_at, 2_000)
    assert.deepEqual(second.credential.scopes, first.credential.scopes)
    assert.equal((await read(first.api_key)).statusCode, 200)
    f.time(1_070)
    assert.equal((await read(first.api_key)).statusCode, 401)
    assert.equal((await read(second.api_key)).statusCode, 200)
    const suspend = await f.app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/identity/subjects/${f.application.subject_id}/suspend`,
      headers: { authorization: "Bearer admin" }, payload: { reason: "key regression" } })
    assert.equal(suspend.statusCode, 200, suspend.body)
    assert.equal((await read(second.api_key)).statusCode, 401)
    const restore = await f.app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/identity/subjects/${f.application.subject_id}/restore`, headers: { authorization: "Bearer admin" } })
    assert.equal(restore.statusCode, 200, restore.body)
    assert.equal((await read(second.api_key)).statusCode, 200)
    const revoked = await f.app.inject({ method: "POST", url: `${f.credentialPath}/${second.credential.credential_id}/revoke`,
      headers: { authorization: "Bearer admin" }, payload: { correlation_id: "revoke-1" } })
    assert.equal(revoked.statusCode, 200, revoked.body)
    assert.equal((await read(second.api_key)).statusCode, 401)
    const after = await f.app.inject({ method: "POST", url: f.credentialPath, headers: { authorization: "Bearer admin" }, payload: input({ correlation_id: "issue-2" }) })
    assert.equal(after.statusCode, 201)
    f.time(2_000)
    assert.equal((await read(after.json().api_key)).statusCode, 401)
  } finally { await f.app.close() }
})

test("Resource-bound API key issuance preserves its discriminator and scope for an OAuth-protected API target", async () => {
  let oauthProvisionerCalls = 0
  let keyInput: IssueApplicationApiKeyCredentialInput | null = null
  const material = createApplicationApiKeyMaterial()
  const f = await fixture({
    async issueApiKeyCredential({ applicationId, value }) {
      keyInput = structuredClone(value)
      return { credential: {
        credential_id: "application-credential-api-key", application_id: applicationId, application_subject_id: "application-subject-key",
        kind: "API_KEY", resource_id: value.resource_id!, capability_id: value.capability_id!, generation: 1, state: "ACTIVE",
        display_name: value.display_name, scopes: value.scopes, key_prefix: material.prefix, expires_at: value.expires_at,
        oauth_client_id: null, oauth_issuer: null, oauth_audience: null, oauth_scope: null,
        created_at: 1_000, activated_at: 1_000, valid_until: null, revoked_at: null,
      }, api_key: material.secret, oauth_client_secret: null, oauth_token_endpoint: null, credential_delivery: "ONE_TIME" }
    },
    async issueOAuthCredential({ applicationId, value }) {
      oauthProvisionerCalls += 1
      return oauthCreation(applicationId, value.resource_id, value.capability_id)
    },
  })
  try {
    const resource = await f.modules.resources.createResource({ tenantId, value: {
      display_name: "OAuth protected records", kind: "API", owner_organization_id: f.organization.organization_id,
      authentication_strategy: "OAUTH", environment_id: "test", version: "1", enforcement_point_id: "gateway-test",
      capabilities: [{ capability_id: "records.read", display_name: "Read records" }], api: {
        api_product_id: "records", openapi_version: "3.1.0", document_title: "Records", document_version: "1", public_path: "/records",
        inbound_security: { type: "OAUTH2", issuer: "https://identity.test", audience: "records", jwks_url: "https://identity.test/jwks", scope: GENIOONE_SCOPES.write },
        request_schema_validation: false, operations: [{ operation_id: "records.read", method: "GET", path: "/records" }],
      },
    } })
    const payload = input({ resource_id: resource.resource_id, capability_id: "records.read" })
    const response = await f.app.inject({ method: "POST", url: f.credentialPath, headers: { authorization: "Bearer admin" }, payload })
    assert.equal(response.statusCode, 201, response.body)
    assert.deepEqual(keyInput, payload)
    assert.equal(oauthProvisionerCalls, 0)
    assert.equal(response.json().credential.kind, "API_KEY")
    assert.deepEqual(response.json().credential.scopes, [GENIOONE_SCOPES.read])
    assert.equal(response.json().oauth_client_secret, null)
  } finally { await f.app.close() }
})

function oauthCreation(applicationId: string, resourceId: string, capabilityId: string): ApplicationApiCredentialCreation {
  return { credential: {
    credential_id: "application-credential-oauth", application_id: applicationId, application_subject_id: "application-subject-key",
    kind: "OAUTH2", resource_id: resourceId, capability_id: capabilityId, generation: 1, state: "ACTIVE",
    display_name: null, scopes: [GENIOONE_SCOPES.write], key_prefix: null, expires_at: null,
    oauth_client_id: "oauth-client", oauth_issuer: "https://identity.test", oauth_audience: "records", oauth_scope: GENIOONE_SCOPES.write,
    created_at: 1_000, activated_at: 1_000, valid_until: null, revoked_at: null,
  }, api_key: null, oauth_client_secret: "one-time-oauth-fixture-secret", oauth_token_endpoint: "https://identity.test/token", credential_delivery: "ONE_TIME" }
}

test("credential issuance strictly rejects unknown kinds and fields while preserving legacy OAuth requests", async () => {
  let keyCalls = 0
  let oauthCalls = 0
  const f = await fixture({
    async issueApiKeyCredential() { keyCalls += 1; throw new Error("Invalid key request reached issuer") },
    async issueOAuthCredential({ applicationId, value }) { oauthCalls += 1; return oauthCreation(applicationId, value.resource_id, value.capability_id) },
  })
  try {
    const payload = input({ resource_id: "resource-oauth", capability_id: "records.read" })
    const missingScope = { ...payload } as Record<string, unknown>
    delete missingScope.scopes
    const missingExpiry = { ...payload } as Record<string, unknown>
    delete missingExpiry.expires_at
    for (const invalid of [{ ...payload, kind: "UNKNOWN" }, { ...payload, extra: "reject" }, missingScope, missingExpiry,
      { correlation_id: "oauth-extra", resource_id: "resource-oauth", capability_id: "records.read", scopes: [GENIOONE_SCOPES.write] }]) {
      const response = await f.app.inject({ method: "POST", url: f.credentialPath, headers: { authorization: "Bearer admin" }, payload: invalid })
      assert.equal(response.statusCode, 400, response.body)
      assert.equal(response.json().code, "REQUEST_VALIDATION_FAILED")
    }
    assert.equal(keyCalls, 0)
    assert.equal(oauthCalls, 0)
    const legacy = await f.app.inject({ method: "POST", url: f.credentialPath, headers: { authorization: "Bearer admin" },
      payload: { correlation_id: "oauth-legacy", resource_id: "resource-oauth", capability_id: "records.read" } })
    assert.equal(legacy.statusCode, 201, legacy.body)
    assert.equal(oauthCalls, 1)
    assert.equal(legacy.json().credential.kind, "OAUTH2")
    assert.equal(legacy.json().api_key, null)
  } finally { await f.app.close() }
})

test("credential management consent cannot issue or rotate API keys beyond its scopes", async () => {
  const f = await fixture()
  try {
    for (const scope of [MANAGEMENT_SCOPES.auditRead, MANAGEMENT_SCOPES.systemRead]) {
      const denied = await f.app.inject({ method: "POST", url: f.credentialPath, headers: { authorization: "Bearer limited" },
        payload: input({ correlation_id: scope, scopes: [scope] }) })
      assert.equal(denied.statusCode, 403)
      assert.equal(denied.json().code, "INSUFFICIENT_SCOPE")
      assert.deepEqual(await f.modules.applications.listCredentials({ tenantId, applicationId: f.application.application_id }), [])
    }
    const issued = await f.app.inject({ method: "POST", url: f.credentialPath, headers: { authorization: "Bearer reader" }, payload: input() })
    assert.equal(issued.statusCode, 201, issued.body)
    const first = issued.json()
    const rotate = (token: string) => f.app.inject({ method: "POST", url: `${f.credentialPath}/${first.credential.credential_id}/rotate`,
      headers: { authorization: `Bearer ${token}` }, payload: { correlation_id: "scope-rotate", grace_period_seconds: 0 } })
    const denied = await rotate("limited")
    assert.equal(denied.statusCode, 403)
    assert.equal(denied.json().code, "INSUFFICIENT_SCOPE")
    assert.equal((await f.modules.applications.listCredentials({ tenantId, applicationId: f.application.application_id })).length, 1)
    const rotated = await rotate("reader")
    assert.equal(rotated.statusCode, 201, rotated.body)
    assert.deepEqual(rotated.json().credential.scopes, [GENIOONE_SCOPES.read])
    const catalog = (key: string) => f.app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/catalog`, headers: { authorization: `Bearer ${key}` } })
    assert.equal((await catalog(first.api_key)).statusCode, 401)
    assert.equal((await catalog(rotated.json().api_key)).statusCode, 200)
  } finally { await f.app.close() }
})

test("API key scope ceilings reject missing, empty and wildcard issuer consent", () => {
  for (const issuer of [undefined, [], ["*"], ["management:audit:*"], [MANAGEMENT_SCOPES.credentialsWrite]]) {
    assert.throws(() => assertApplicationCredentialScopeCeiling([MANAGEMENT_SCOPES.auditRead], issuer), hasCode("INSUFFICIENT_SCOPE"))
  }
  assert.doesNotThrow(() => assertApplicationCredentialScopeCeiling([GENIOONE_SCOPES.read], [GENIOONE_SCOPES.read, MANAGEMENT_SCOPES.credentialsWrite]))
})
