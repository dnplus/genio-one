import assert from "node:assert/strict"
import test from "node:test"
import {
  WorkloadIdentityStore,
  createCompositePrincipalAuthenticator,
  type WorkloadTokenVerifier,
} from "../src/capabilities/tenancy-auth/workload-identity"
import type { PrincipalAuthenticator } from "../src/capabilities/tenancy-auth/contract"

test("Workload Identity exchanges external token for short-lived acting credential", async () => {
  const store = new WorkloadIdentityStore(undefined, 900)

  const fakeJwtPayload = Buffer.from(
    JSON.stringify({
      sub: "repo:org/app:ref:refs/heads/main",
      iss: "https://token.actions.githubusercontent.com",
      aud: "genio-one-workload",
    })
  ).toString("base64url")
  const mockToken = `header.${fakeJwtPayload}.sig`

  const result = await store.exchange({
    tenantId: "tenant-test",
    workloadToken: mockToken,
    provider: "github-actions",
    requestedActingClientId: "ci-pipeline-1",
  })

  assert.equal(result.token_type, "Bearer")
  assert.equal(result.scope, "genioone-invocation")
  assert.equal(result.expires_in, 900)
  assert.equal(result.subject_id, "workload:repo:org/app:ref:refs/heads/main")
  assert.equal(result.acting_client_id, "ci-pipeline-1")
  assert.ok(result.access_token.startsWith("genio_acting_"))

  const principal = store.authenticate(result.access_token, "tenant-test")
  assert.ok(principal)
  assert.equal(principal.tenant_id, "tenant-test")
  assert.equal(principal.role, "USER")
  assert.equal(principal.client_id, "ci-pipeline-1")
  assert.deepEqual(principal.scopes, ["genioone-invocation"])

  const crossTenantPrincipal = store.authenticate(result.access_token, "tenant-other")
  assert.equal(crossTenantPrincipal, null)
})

test("Composite authenticator delegates acting token to workload store and fallback to primary", async () => {
  const store = new WorkloadIdentityStore()
  const primary: PrincipalAuthenticator = {
    authenticate({ token, tenantId }) {
      if (token === "valid_user_oidc_token") {
        return {
          tenant_id: tenantId,
          subject_id: "user-real",
          role: "USER",
          organization_ids: [],
          client_id: "web-client",
        }
      }
      return null
    },
  }

  const composite = createCompositePrincipalAuthenticator(primary, store)

  const userPrincipal = await composite.authenticate({
    token: "valid_user_oidc_token",
    tenantId: "tenant-1",
  })
  assert.ok(userPrincipal)
  assert.equal(userPrincipal.subject_id, "user-real")

  const fakeJwtPayload = Buffer.from(
    JSON.stringify({ sub: "worker-process", iss: "internal-cluster" })
  ).toString("base64url")
  const mockToken = `h.${fakeJwtPayload}.s`

  const exchangeResult = await store.exchange({
    tenantId: "tenant-1",
    workloadToken: mockToken,
    provider: "kubernetes",
  })

  const workloadPrincipal = await composite.authenticate({
    token: exchangeResult.access_token,
    tenantId: "tenant-1",
  })
  assert.ok(workloadPrincipal)
  assert.equal(workloadPrincipal.subject_id, "workload:worker-process")
})

test("Workload Identity verifies custom verifier rejection", async () => {
  const verifier: WorkloadTokenVerifier = {
    async verify() {
      throw new Error("Invalid cryptographic signature on ID token")
    },
  }

  const store = new WorkloadIdentityStore(verifier)

  await assert.rejects(
    () =>
      store.exchange({
        tenantId: "tenant-1",
        workloadToken: "bad.jwt.token",
        provider: "github-actions",
      }),
    {
      name: "PlatformApiError",
      message: "Invalid cryptographic signature on ID token",
    }
  )
})
