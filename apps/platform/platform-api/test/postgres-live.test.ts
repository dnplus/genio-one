import assert from "node:assert/strict"
import { generateKeyPairSync, randomUUID } from "node:crypto"
import test from "node:test"

import { createClient } from "redis"

import { createManagementApi } from "../src/app"
import { createPlatformModuleGraph } from "../src/capabilities/platform-modules-live"
import { createDurableEd25519Signer } from "../src/capabilities/gateway-projection/signer"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"
import { runMigrations } from "../src/persistence/migration-runner"
import { createPostgresSqlAdapter } from "../src/persistence/sql-adapter"
import { admitUsage } from "../src/capabilities/usage-governance/admission"

const databaseUrl = process.env.GENIO_ONE_TEST_DATABASE_URL
const valkeyUrl = process.env.GENIO_ONE_TEST_VALKEY_URL
const fixtureId = randomUUID().slice(0, 8)
const tenantId = `tenant-platform-api-live-${fixtureId}`
const runtimeId = `gateway-runtime-live-${fixtureId}`

function testSigner(keyId: string) {
  const { privateKey } = generateKeyPairSync("ed25519")
  return createDurableEd25519Signer({
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }),
    keyId,
  })
}

async function clearFixtureTenant(
  sql: ReturnType<typeof createPostgresSqlAdapter>,
): Promise<void> {
  await sql.transaction(async (transaction) => {
    for (const table of [
      "genio_one_cost_valuations",
      "genio_one_canonical_charges",
      "genio_one_usage_quantities",
      "genio_one_canonical_invocation_accounting",
      "genio_one_routing_attempt_events",
      "genio_one_gateway_activities",
      "genio_one_platform_runtime_aggregate_observed_states",
      "genio_one_platform_runtime_aggregate_report_history",
      "genio_one_platform_runtime_aggregate_commands",
      "genio_one_platform_runtime_capabilities",
      "genio_one_platform_runtime_session_leases",
      "genio_one_platform_runtime_registrations",
      "genio_one_gateway_policy_release_heads",
      "genio_one_gateway_policy_release_manifests",
      "genio_one_gateway_policy_release_projections",
      "genio_one_gateway_policy_releases",
      "genio_one_model_routing_policies",
      "genio_one_model_entitlements",
      "genio_one_publication_build_attempts",
      "genio_one_gateway_projections",
      "genio_one_publications",
      "genio_one_model_route_transitions",
      "genio_one_enforcement_chain_revisions",
      "genio_one_connection_model_mappings",
      "genio_one_public_models",
      "genio_one_resource_connections",
      "genio_one_resources",
      "genio_one_provider_profiles",
      "genio_one_organizations",
      "genio_one_mutation_idempotency_receipts",
    ]) {
      await transaction.query(`delete from ${table} where tenant_id = $1`, [tenantId])
    }
  })
}

async function jsonResponse(
  app: Awaited<ReturnType<typeof createManagementApi>>,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  body?: unknown,
  token = "live-test-token",
) {
  const response = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { payload: body as object }),
  } as never)
  return {
    response,
    body: response.body ? (response.json() as Record<string, any>) : {},
  }
}

const jwtAuthentication = {
  schema_version: "genio.one.auth.jwt.v1",
  provider: "test-oidc",
  issuer: "https://issuer.example.test",
  audiences: ["genio-one"],
  remote_jwks_uri: "https://issuer.example.test/.well-known/jwks.json",
  subject_claim: "sub",
  client_claim: "azp",
}

test(
  "PostgreSQL and Valkey execute the AI Gateway publication slice",
  { skip: !databaseUrl || !valkeyUrl, timeout: 30_000 },
  async () => {
    assert.ok(databaseUrl)
    assert.ok(valkeyUrl)
    const sql = createPostgresSqlAdapter({ url: databaseUrl })
    const valkey = createClient({ url: valkeyUrl })
    const signingRoles = {
      projection: testSigner("projection-live-contract"),
      runtimeCommand: testSigner("runtime-command-live-contract"),
      policyArtifact: testSigner("policy-artifact-live-contract"),
      releaseRoot: testSigner("release-root-live-contract"),
    }
    const runtimeReportSigner = testSigner("runtime-report-live-contract")
    let app: Awaited<ReturnType<typeof createManagementApi>> | undefined

    try {
      await runMigrations(sql)
      await clearFixtureTenant(sql)
      await valkey.connect()
      const modules = createPlatformModuleGraph({
        sql,
        valkey: {
          get: (key) => valkey.get(key),
          async set(key, value, options) {
            return (await valkey.set(key, value, options)) === "OK" ? "OK" : null
          },
          eval: (script, options) => valkey.eval(script, options),
        },
        signingRoles,
        gatewayReleaseTtlSeconds: 600,
        mcpOAuthEncryptionKey: Buffer.alloc(32),
        mcpOAuthPublicOrigin: "http://127.0.0.1:58082",
        managementUiOrigin: "http://127.0.0.1:5173",
        platformOrigin: "http://127.0.0.1:58082",
        defaultGatewayId: "genio-ai-mcp-gateway",
        gatewayIdentityProvisioner: {
          async provision({ clientId }) {
            return {
              issuer: "https://issuer.example.test",
              token_endpoint: "https://issuer.example.test/token",
              audience: "genio-one-product-api",
              scope: "genioone-gateway-runtime",
              client_id: clientId,
              client_secret: "gateway-secret",
            }
          },
          async revoke() {},
        },
        applicationTokenBroker: {
          async mint() {
            throw new Error("not used")
          },
        },
        workloadAssertionVerifier: {
          async verify() {
            throw new Error("not used")
          },
        },
        connectionVerifier: { verify: async () => true },
        publicationDnsVerifier: { verify: async () => true },
      })
      app = await createManagementApi({
        logger: process.env.GENIO_ONE_LIVE_TEST_LOG === "1",
        modules,
        resourceCatalog: modules.resources,
        principalAuthenticator: createStaticPrincipalAuthenticator({
          "live-test-token": {
            tenant_id: tenantId,
            subject_id: "person-live",
            role: "TENANT_ADMINISTRATOR",
            organization_ids: [],
            client_id: "client-live",
          },
          "live-runtime-token": {
            tenant_id: tenantId,
            subject_id: "gateway-runtime-live",
            role: "USER",
            organization_ids: [],
            client_id: runtimeId,
          },
        }),
        entitlementResolver: modules.entitlements,
      })
      await app.ready()

      const registration = await jsonResponse(
        app,
        "PUT",
        `/v1/tenants/${tenantId}/runtime-control/GATEWAY/${runtimeId}/registration`,
        {
          target_id: "ai-gateway-test",
          oidc_client_id: runtimeId,
          report_key_id: runtimeReportSigner.keyId,
          report_public_key_pem: runtimeReportSigner.publicKeyPem,
          status: "ACTIVE",
        },
        "live-runtime-token",
      )
      assert.equal(registration.response.statusCode, 200, registration.response.body)
      const capabilities = await jsonResponse(
        app,
        "PUT",
        `/v1/tenants/${tenantId}/runtime-control/GATEWAY/${runtimeId}/capabilities`,
        {
          protocol_versions: ["genio.one.runtime.v1"],
          preferred_protocol_version: "genio.one.runtime.v1",
          delivery_mode: "AGGREGATE_RELEASE",
        },
        "live-runtime-token",
      )
      assert.equal(capabilities.response.statusCode, 200, capabilities.response.body)

      const organization = await jsonResponse(
        app,
        "POST",
        `/v1/tenants/${tenantId}/organizations`,
        { display_name: "Live Contract", slug: "live-contract" },
      )
      assert.equal(organization.response.statusCode, 201, organization.response.body)

      const resource = await jsonResponse(
        app,
        "POST",
        `/v1/tenants/${tenantId}/resources`,
        {
          display_name: "Live AI",
          kind: "LLM",
          owner_organization_id: organization.body.organization_id,
          authentication_strategy: "OAUTH",
          environment_id: "test",
          version: "1.0.0",
          capabilities: [{ capability_id: "chat", display_name: "Chat" }],
          enforcement_point_id: "ai-gateway-test",
        },
      )
      assert.equal(resource.response.statusCode, 201, resource.response.body)

      const connection = await jsonResponse(
        app,
        "POST",
        `/v1/tenants/${tenantId}/resources/${resource.body.resource_id}/connections`,
        {
          display_name: "Local Ollama",
          provider_type: "OLLAMA",
          endpoint: "http://127.0.0.1:11434",
        },
      )
      assert.equal(connection.response.statusCode, 201, connection.response.body)
      const verified = await jsonResponse(
        app,
        "POST",
        `/v1/tenants/${tenantId}/resources/${resource.body.resource_id}/connections/${connection.body.connection_id}/verify`,
      )
      assert.equal(verified.response.statusCode, 200, verified.response.body)

      const model = await jsonResponse(
        app,
        "POST",
        `/v1/tenants/${tenantId}/resources/${resource.body.resource_id}/models`,
        {
          model_name: "corporate-chat",
          display_name: "Corporate Chat",
          mappings: [{
            connection_id: connection.body.connection_id,
            provider_model: "llama3.2:3b",
          }],
          capabilities: ["CHAT", "STREAMING"],
          visibility: "PUBLIC",
        },
      )
      assert.equal(model.response.statusCode, 201, model.response.body)

      const routingPolicy = await jsonResponse(
        app,
        "PUT",
        `/v1/tenants/${tenantId}/resources/${resource.body.resource_id}/capabilities/chat/model-routing-policy`,
        {
          routing_revision: 1,
          mode: "DETERMINISTIC",
          candidate_public_model_ids: [model.body.model_id],
          default_public_model_id: model.body.model_id,
          session_lease_seconds: null,
        },
      )
      assert.equal(routingPolicy.response.statusCode, 200, routingPolicy.response.body)

      const chain = await jsonResponse(
        app,
        "POST",
        `/v1/tenants/${tenantId}/resources/${resource.body.resource_id}/capabilities/chat/enforcement-chain`,
        {
          one_policy_revision: 1,
          steps: [
            {
              step_id: "authenticate",
              kind: "AUTHENTICATE",
              phase: "REQUEST",
              implementation: "NATIVE",
              config: jwtAuthentication,
            },
            {
              step_id: "authorize",
              kind: "AUTHORIZE",
              phase: "REQUEST",
              implementation: "EXT_AUTH",
              depends_on: ["authenticate"],
            },
            {
              step_id: "route",
              kind: "ROUTE",
              phase: "ROUTING",
              implementation: "AIGW_NATIVE",
              depends_on: ["authorize"],
            },
          ],
        },
      )
      assert.equal(chain.response.statusCode, 200, chain.response.body)

      const endpoint = await jsonResponse(
        app,
        "PUT",
        `/v1/tenants/${tenantId}/resources/${resource.body.resource_id}/publication-endpoint`,
        {
          gateway_id: "ai-gateway-test",
          hostname: "ai.example.test",
          base_path: "/",
          visibility: "PUBLIC",
          dns_management: "EXTERNAL",
          dns_verification: "VERIFIED",
          dns_target: "gateway.example.test",
        },
      )
      assert.equal(endpoint.response.statusCode, 200, endpoint.response.body)

      const editedDraft = await jsonResponse(
        app,
        "PATCH",
        `/v1/tenants/${tenantId}/resources/${resource.body.resource_id}`,
        { version: "1.0.1" },
      )
      assert.equal(editedDraft.response.statusCode, 200, editedDraft.response.body)
      assert.equal(editedDraft.body.version, "1.0.1")

      const synchronizedPublication = await sql.query<{
        publication_revision: number
        resource_revision: number
      }>(
        `select p.resource_revision as publication_revision,
                r.row_revision as resource_revision
           from genio_one_publications p
           join genio_one_resources r
             on r.tenant_id = p.tenant_id and r.resource_id = p.resource_id
          where p.tenant_id = $1 and p.resource_id = $2`,
        [tenantId, resource.body.resource_id],
      )
      assert.equal(
        Number(synchronizedPublication.rows[0]?.publication_revision),
        Number(synchronizedPublication.rows[0]?.resource_revision),
      )

      const agentSubject = await jsonResponse(
        app,
        "POST",
        `/v1/tenants/${tenantId}/identity/subjects`,
        {
          kind: "AGENT",
          subject_id: "person-live",
          display_name: "Live contract agent",
        },
      )
      assert.equal(agentSubject.response.statusCode, 201, agentSubject.response.body)

      const entitlement = await jsonResponse(
        app,
        "POST",
        `/v1/tenants/${tenantId}/entitlements`,
        {
          subject_id: "person-live",
          client_id: "client-live",
          resource_id: resource.body.resource_id,
          capability_id: "chat",
          public_model_id: model.body.model_id,
        },
      )
      assert.equal(entitlement.response.statusCode, 201, entitlement.response.body)

      const requested = await jsonResponse(
        app,
        "POST",
        `/v1/tenants/${tenantId}/resources/${resource.body.resource_id}/publication-requests`,
        {},
      )
      assert.equal(requested.response.statusCode, 201, requested.response.body)
      const rejected = await jsonResponse(
        app,
        "POST",
        `/v1/tenants/${tenantId}/resources/${resource.body.resource_id}/publication-requests/${requested.body.request_id}/review`,
        { decision: "REJECT" },
      )
      assert.equal(rejected.response.statusCode, 200, rejected.response.body)
      assert.equal(rejected.body.lifecycle, "DRAFT")
      const resetPublication = await sql.query<{
        publication_snapshot: Record<string, unknown>
        policy_revision: number
      }>(
        `select publication_snapshot, policy_revision
           from genio_one_publications
          where tenant_id = $1 and resource_id = $2`,
        [tenantId, resource.body.resource_id],
      )
      assert.deepEqual(resetPublication.rows[0]?.publication_snapshot, {})
      assert.equal(Number(resetPublication.rows[0]?.policy_revision), 0)

      const staleCandidate = await jsonResponse(
        app,
        "POST",
        `/v1/tenants/${tenantId}/resources/${resource.body.resource_id}/publication-requests`,
        {},
      )
      assert.equal(staleCandidate.response.statusCode, 201, staleCandidate.response.body)
      assert.notEqual(staleCandidate.body.request_id, requested.body.request_id)

      const nextChain = await jsonResponse(
        app,
        "POST",
        `/v1/tenants/${tenantId}/resources/${resource.body.resource_id}/capabilities/chat/enforcement-chain`,
        {
          one_policy_revision: 2,
          steps: [
            {
              step_id: "authenticate",
              kind: "AUTHENTICATE",
              phase: "REQUEST",
              implementation: "NATIVE",
              config: jwtAuthentication,
            },
            {
              step_id: "authorize",
              kind: "AUTHORIZE",
              phase: "REQUEST",
              implementation: "EXT_AUTH",
              depends_on: ["authenticate"],
            },
            {
              step_id: "route",
              kind: "ROUTE",
              phase: "ROUTING",
              implementation: "AIGW_NATIVE",
              depends_on: ["authorize"],
            },
          ],
        },
      )
      assert.equal(nextChain.response.statusCode, 200, nextChain.response.body)

      const nextRoutingPolicy = await jsonResponse(
        app,
        "PUT",
        `/v1/tenants/${tenantId}/resources/${resource.body.resource_id}/capabilities/chat/model-routing-policy`,
        {
          routing_revision: 2,
          mode: "DETERMINISTIC",
          candidate_public_model_ids: [model.body.model_id],
          default_public_model_id: model.body.model_id,
          session_lease_seconds: null,
        },
      )
      assert.equal(nextRoutingPolicy.response.statusCode, 200, nextRoutingPolicy.response.body)

      const staleReview = await jsonResponse(
        app,
        "POST",
        `/v1/tenants/${tenantId}/resources/${resource.body.resource_id}/publication-requests/${staleCandidate.body.request_id}/review`,
        { decision: "APPROVE" },
      )
      assert.equal(staleReview.response.statusCode, 409, staleReview.response.body)
      assert.equal(staleReview.body.code, "PUBLICATION_SNAPSHOT_STALE")

      const rejectedStale = await jsonResponse(
        app,
        "POST",
        `/v1/tenants/${tenantId}/resources/${resource.body.resource_id}/publication-requests/${staleCandidate.body.request_id}/review`,
        { decision: "REJECT" },
      )
      assert.equal(rejectedStale.response.statusCode, 200, rejectedStale.response.body)

      const finalRequest = await jsonResponse(
        app,
        "POST",
        `/v1/tenants/${tenantId}/resources/${resource.body.resource_id}/publication-requests`,
        {},
      )
      assert.equal(finalRequest.response.statusCode, 201, finalRequest.response.body)
      const reviewed = await jsonResponse(
        app,
        "POST",
        `/v1/tenants/${tenantId}/resources/${resource.body.resource_id}/publication-requests/${finalRequest.body.request_id}/review`,
        { decision: "APPROVE" },
      )
      assert.equal(reviewed.response.statusCode, 200, reviewed.response.body)
      assert.equal(reviewed.body.lifecycle, "PUBLISHED")

      const aggregateDelivery = await sql.query<{
        release_count: string
        command_count: string
      }>(
        `select
           (select count(*) from genio_one_gateway_policy_releases
             where tenant_id = $1 and gateway_id = $2) as release_count,
           (select count(*) from genio_one_platform_runtime_aggregate_commands
             where tenant_id = $1 and runtime_id = $3) as command_count`,
        [tenantId, "ai-gateway-test", runtimeId],
      )
      assert.equal(Number(aggregateDelivery.rows[0]?.release_count), 1)
      assert.equal(Number(aggregateDelivery.rows[0]?.command_count), 1)

      const routed = await jsonResponse(
        app,
        "POST",
        `/v1/tenants/${tenantId}/model-routing/resolve`,
        {
          public_model_id: model.body.model_id,
          requested_public_model_id: model.body.model_id,
          session_id: "live-session",
        },
      )
      assert.equal(routed.response.statusCode, 200, routed.response.body)
      assert.equal(routed.body.provider_model, "llama3.2:3b")

      const accountingUrl = `/v1/tenants/${tenantId}/runtime-control/GATEWAY/${runtimeId}/accounting`
      const invocationId = `invocation-live-${fixtureId}`
      const accountingAt = Math.floor(Date.now() / 1_000)
      const accountingPayload = {
        invocation: {
          invocation_id: invocationId,
          correlation_id: `accounting-live-${fixtureId}`,
          tenant_id: tenantId,
          subject_id: "person-live",
          consumer_organization_id: organization.body.organization_id,
          resource_owner_organization_id: organization.body.organization_id,
          resource_id: resource.body.resource_id,
          capability_id: "chat",
          use_case_id: "live-use-case",
          usage_policy_revisions: [`currency-live-${fixtureId}:1`],
          release_revision: "release-live",
          accounting_key_id: `accounting-live-${fixtureId}`,
          created_at: accountingAt,
        },
        quantities: [{
          quantity_id: `quantity-live-${fixtureId}`,
          invocation_id: invocationId,
          quantity: 3,
          unit: "TOTAL_TOKENS",
          trusted_source: "PROVIDER_RESPONSE",
          observed_at: accountingAt + 1,
        }],
        valuations: [{
          valuation_id: `valuation-estimated-live-${fixtureId}`,
          status: "ESTIMATED",
          currency: "USD",
          amount_micros: 9,
          pricing_source: "LITELLM",
          pricing_version: "f".repeat(64),
          valued_at: accountingAt + 1,
        }],
        currency_settlements: [],
      }
      const accountingRecorded = await jsonResponse(app, "POST", accountingUrl, accountingPayload, "live-runtime-token")
      const accountingRepeated = await jsonResponse(app, "POST", accountingUrl, accountingPayload, "live-runtime-token")
      assert.equal(accountingRecorded.response.statusCode, 201, accountingRecorded.response.body)
      assert.equal(accountingRepeated.response.statusCode, 201, accountingRepeated.response.body)
      assert.equal(accountingRepeated.body.charge_id, accountingRecorded.body.charge_id)
      const accountingActual = await jsonResponse(app, "POST", accountingUrl, {
        ...accountingPayload,
        valuations: [{
          valuation_id: `valuation-actual-live-${fixtureId}`,
          status: "ACTUAL",
          currency: "USD",
          amount_micros: 11,
          pricing_source: "PROVIDER_INVOICE",
          pricing_version: "invoice-live",
          valued_at: accountingAt + 2,
        }],
      }, "live-runtime-token")
      assert.equal(accountingActual.response.statusCode, 201, accountingActual.response.body)
      const accountingDetail = await jsonResponse(
        app,
        "GET",
        `/v1/tenants/${tenantId}/activities/accounting-live-${fixtureId}/accounting`,
      )
      assert.deepEqual(accountingDetail.body[0].valuations.map((value: any) => value.status), ["ESTIMATED", "ACTUAL"])

      const activityCorrelation = `usage-admission-live-${fixtureId}`
      const activityRecorded = await jsonResponse(
        app,
        "POST",
        `/v1/tenants/${tenantId}/runtime-control/GATEWAY/${runtimeId}/activities`,
        {
          correlation_id: activityCorrelation,
          resource_id: resource.body.resource_id,
          capability_id: "chat",
          application_id: null,
          subject_id: "person-live",
          acting_client_id: "client-live",
          entitlement_id: "entitlement-live",
          usage_admission_id: `admission-live-${fixtureId}`,
          usage_admission_disposition: "ADMIT",
          usage_admission_reason: null,
          consumer_organization_id: organization.body.organization_id,
          resource_owner_organization_id: organization.body.organization_id,
          use_case_id: "live-use-case",
          enforcement_point_id: "AI_GATEWAY",
          route: "MANAGED",
          method: "POST",
          path: "/v1/chat/completions",
          status_code: 200,
          outcome: "COMPLETED",
          error_code: null,
          latency_millis: 12,
          upstream_attempted: true,
          requested_model_id: model.body.model_id,
          effective_model_id: "llama3.2:3b",
          provider_id: "OLLAMA",
          connection_id: connection.body.connection_id,
          mcp_method: null,
          mcp_tool: null,
          mcp_backend: null,
          processor_bundle_revision: "release-live",
          processor_request_steps: [],
          processor_response_steps: [],
          data_classifications: [],
          input_tokens: 1,
          output_tokens: 2,
          total_tokens: 3,
          route_mode: "DETERMINISTIC",
          route_lease_id: null,
          route_lease_reused: null,
          routing_policy_id: null,
          routing_revision: null,
          candidate_set_digest: null,
          candidate_connection_ids: [connection.body.connection_id],
          release_id: null,
          release_head_revision: null,
          detail_availability: "NOT_CAPTURED",
          detail_ref: null,
          detail_expires_at: null,
          occurred_at: accountingAt,
        },
        "live-runtime-token",
      )
      assert.equal(activityRecorded.response.statusCode, 201, activityRecorded.response.body)
      assert.equal(activityRecorded.body.usage_admission_disposition, "ADMIT")
      assert.equal(activityRecorded.body.consumer_organization_id, organization.body.organization_id)
      const activityInventory = await jsonResponse(app, "GET", `/v1/tenants/${tenantId}/api-activities?limit=20`)
      const liveActivity = activityInventory.body.events.find((event: any) => event.correlation_id === activityCorrelation)
      assert.equal(liveActivity.usage_admission_id, `admission-live-${fixtureId}`)
      assert.equal(liveActivity.use_case_id, "live-use-case")

      const currencyPolicy = {
        usage_policy_id: `currency-live-${fixtureId}`,
        revision: 1,
        accounting_key_id: `accounting-live-${fixtureId}`,
        selectors: { resource_id: resource.body.resource_id },
        limits: {
          currency_budget: {
            allocation_id: `allocation-live-${fixtureId}`,
            window_seconds: 60,
            currency: "USD",
            limit_micros: 10,
          },
        },
      }
      const usageContext = {
        tenant_id: tenantId,
        subject_id: "person-live",
        consumer_organization_id: organization.body.organization_id,
        resource_owner_organization_id: organization.body.organization_id,
        resource_id: resource.body.resource_id,
        capability_id: "chat",
        use_case_id: "live-use-case",
        correlation_id: `currency-live-${fixtureId}-1`,
        pricing: { currency: "USD", source: "LITELLM", version: "f".repeat(64) },
        now: Math.floor(Date.now() / 1_000),
      }
      const currencyAdmission = await admitUsage({
        context: usageContext,
        policies: [currencyPolicy],
        store: modules.usageCounterStore,
      })
      assert.equal(currencyAdmission.disposition, "ADMIT", JSON.stringify(currencyAdmission))
      if (currencyAdmission.disposition !== "ADMIT") throw new Error("currency admission failed")
      await modules.usageCounterStore.settleCurrency({
        settlement_id: `invocation-live-${fixtureId}`,
        ...currencyAdmission.currency_allocations[0]!,
        amount_micros: 11,
      })
      const currencyBlocked = await admitUsage({
        context: { ...usageContext, correlation_id: `currency-live-${fixtureId}-2` },
        policies: [currencyPolicy],
        store: modules.usageCounterStore,
      })
      assert.equal(currencyBlocked.disposition, "REJECT")
      assert.equal(currencyBlocked.reason, "COST_BUDGET_EXHAUSTED")
    } finally {
      if (app) await app.close()
      if (valkey.isOpen) {
        for await (const entry of valkey.scanIterator({ MATCH: `genio:usage:accounting-live-${fixtureId}*` })) {
          const keys = Array.isArray(entry) ? entry : [entry]
          if (keys.length > 0) await valkey.del(keys)
        }
        await valkey.quit()
      }
      await clearFixtureTenant(sql).catch(() => undefined)
      await sql.end({ timeout: 5 })
    }
  },
)
