import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import test from "node:test"

import type { GatewayAuthorizationAuditStore } from "../src/capabilities/audit-events/module"
import { createPostgresGatewayAuthorizationAuditStore } from "../src/capabilities/audit-events/postgres"
import { PlatformApiError } from "../src/capabilities/errors"
import { compileValidatedEnforcementChain } from "../src/capabilities/enforcement/compiler"
import type { CompiledEnforcementChain, CompileEnforcementChainInput } from "../src/capabilities/enforcement/contract"
import { createPostgresEnforcementChainRevisionStore } from "../src/capabilities/enforcement/postgres"
import { resourcePolicyKey, createPolicyDraftStore } from "../src/capabilities/one-policy/drafts"
import { createPostgresSqlAdapter, type PostgresSqlAdapter } from "../src/persistence/sql-adapter"

const persistenceUrl = process.env.GENIO_ONE_TEST_DATABASE_URL ?? process.env.GENIO_ONE_DATABASE_URL
const persistenceTestEnabled = process.env.GENIO_ONE_ENFORCEMENT_PERSISTENCE_TEST === "1"

const tenantId = "tenant-enforcement-publish"
const organizationId = "organization-enforcement-publish"
const resourceId = "resource-enforcement-publish"
const providerProfileId = "profile-enforcement-publish"

const jwt = {
  schema_version: "genio.one.auth.jwt.v1" as const,
  provider: "keycloak",
  issuer: "https://identity.example.test/realms/acme",
  audiences: ["genio-one"],
  remote_jwks_uri: "https://identity.example.test/realms/acme/protocol/openid-connect/certs",
  subject_claim: "sub",
  client_claim: "azp",
}

function steps(): CompileEnforcementChainInput["steps"] {
  return [
    {
      step_id: "authenticate",
      kind: "AUTHENTICATE",
      phase: "REQUEST",
      implementation: "NATIVE",
      depends_on: [],
      config: jwt,
    },
    {
      step_id: "authorize",
      kind: "AUTHORIZE",
      phase: "REQUEST",
      implementation: "EXT_AUTH",
      depends_on: ["authenticate"],
      config: {},
    },
    {
      step_id: "route",
      kind: "ROUTE",
      phase: "ROUTING",
      implementation: "AIGW_NATIVE",
      depends_on: ["authorize"],
      config: {},
    },
  ]
}

type Fixture = {
  schema: string
  setup: PostgresSqlAdapter
  sql: PostgresSqlAdapter
}

async function createFixture(): Promise<Fixture> {
  assert.ok(persistenceUrl)
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(persistenceUrl).hostname))
  const schema = `enforcementdraftqa_${randomUUID().replaceAll("-", "")}`
  const setup = createPostgresSqlAdapter({ url: persistenceUrl })
  await setup.query(`create schema ${schema}`)
  const sql = createPostgresSqlAdapter({
    url: persistenceUrl,
    options: { max: 2, connection: { search_path: schema } },
  })
  try {
    await sql.query(await readFile(new URL("../migrations/001_platform_baseline.sql", import.meta.url), "utf8"))
    await seed(sql)
    return { schema, setup, sql }
  } catch (error) {
    await sql.end({ timeout: 1 })
    await setup.query(`set client_min_messages = warning; drop schema ${schema} cascade`)
    await setup.end({ timeout: 1 })
    throw error
  }
}

async function seed(sql: PostgresSqlAdapter): Promise<void> {
  await sql.query(
    `insert into genio_one_organizations (tenant_id, organization_id, display_name, slug)
     values ($1, $2, $3, $4)`,
    [tenantId, organizationId, "Enforcement QA", "enforcement-qa"],
  )
  await sql.query(
    `insert into genio_one_provider_profiles
       (tenant_id, profile_id, display_name, provider_type, protocol,
        capabilities, model_discovery, endpoint_required, credential_required)
     values ($1, $2, $3, $4, $5, $6::text::jsonb, $7, $8, $9)`,
    [tenantId, providerProfileId, "Enforcement Provider", "OPENAI", "HTTPS", "[]", "NONE", false, false],
  )
  await sql.query(
    `insert into genio_one_resources
       (tenant_id, resource_id, display_name, kind, owner_organization_id,
        authentication_strategy, environment_id, version, lifecycle,
        operational_state, capabilities, enforcement_point_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text::jsonb, $12)`,
    [
      tenantId,
      resourceId,
      "Enforcement Resource",
      "LLM",
      organizationId,
      "OAUTH",
      "local",
      "1.0.0",
      "DRAFT",
      "HEALTHY",
      JSON.stringify([
        { capability_id: "missing", display_name: "Missing" },
        { capability_id: "not-ready", display_name: "Not Ready" },
        { capability_id: "duplicate", display_name: "Duplicate" },
        { capability_id: "reversed", display_name: "Reversed" },
        { capability_id: "audit-failure", display_name: "Audit Failure" },
        { capability_id: "fallback", display_name: "Fallback" },
        { capability_id: "race", display_name: "Race" },
      ]),
      "AI_GATEWAY",
    ],
  )
  for (const [connectionId, displayName, status] of [
    ["connection-a", "Zulu Display", "READY"],
    ["connection-z", "Alpha Display", "READY"],
    ["connection-not-ready", "Not Ready Display", "DRAFT"],
  ] as const) {
    await sql.query(
      `insert into genio_one_resource_connections
         (tenant_id, resource_id, connection_id, display_name,
          provider_type, provider_profile_id, endpoint, status,
          connection_kind, lifecycle, verification_state, health_state)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        tenantId,
        resourceId,
        connectionId,
        displayName,
        "OPENAI",
        providerProfileId,
        `https://${connectionId}.example.test`,
        status,
        "LLM",
        "ENABLED",
        status === "READY" ? "VERIFIED" : "UNVERIFIED",
        status === "READY" ? "HEALTHY" : "UNKNOWN",
      ],
    )
  }
}

async function createReviewedDraft(
  sql: PostgresSqlAdapter,
  capability: string,
  eligibleConnectionIds?: string[],
) {
  const drafts = createPolicyDraftStore(sql)
  const policyKey = resourcePolicyKey(resourceId, capability)
  const saved = await drafts.save(
    tenantId,
    policyKey,
    {
      expected_version: 0,
      base_revision: 0,
      content: {
        kind: "RESOURCE_CAPABILITY",
        definition: {
          one_policy_revision: 1,
          ...(eligibleConnectionIds ? { eligible_connection_ids: eligibleConnectionIds } : {}),
          steps: steps(),
        },
      },
    },
    { actorSubjectId: "author", correlationId: `${capability}-save`, at: 1_700_000_000 },
  )
  const validated = await drafts.validate(tenantId, policyKey, {
    expectedVersion: saved.version,
    expectedContentDigest: saved.content_digest,
    context: { actorSubjectId: "validator", correlationId: `${capability}-validate`, at: 1_700_000_001 },
  })
  const reviewed = await drafts.review(tenantId, policyKey, {
    expectedVersion: validated.version,
    expectedContentDigest: validated.content_digest,
    context: { actorSubjectId: "reviewer", correlationId: `${capability}-review`, at: 1_700_000_002 },
  })
  return { drafts, policyKey, reviewed }
}

function errorCode(error: unknown): string | null {
  return error instanceof PlatformApiError ? error.code : null
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  const { promise, resolve } = Promise.withResolvers<T>()
  return { promise, resolve }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function cleanup(fixture: Fixture): Promise<void> {
  await fixture.sql.end({ timeout: 1 })
  await fixture.setup.query(`set client_min_messages = warning; drop schema ${fixture.schema} cascade`)
  await fixture.setup.end({ timeout: 1 })
}

test(
  "PostgreSQL publishDraft validates candidates and retains requested priority in an isolated baseline",
  { skip: !persistenceTestEnabled || !persistenceUrl, timeout: 30_000 },
  async () => {
    const fixture = await createFixture()
    try {
      const store = createPostgresEnforcementChainRevisionStore({ sql: fixture.sql, now: () => 1_700_000_010 })
      const scenarios = [
        { capability: "missing", candidates: ["connection-missing"], code: "ENFORCEMENT_CONNECTION_MISMATCH" },
        { capability: "not-ready", candidates: ["connection-not-ready"], code: "ENFORCEMENT_CONNECTION_NOT_READY" },
      ] as const

      for (const scenario of scenarios) {
        const prepared = await createReviewedDraft(fixture.sql, scenario.capability, [...scenario.candidates])
        await assert.rejects(
          store.publishDraft({
            tenantId,
            resourceId,
            capabilityId: scenario.capability,
            expectedVersion: prepared.reviewed.version,
            expectedContentDigest: prepared.reviewed.content_digest,
            publishedBySubjectId: "publisher",
            correlationId: `${scenario.capability}-publish`,
          }),
          (error: unknown) => errorCode(error) === scenario.code,
        )
        assert.equal(await store.getLatest({ tenantId, resourceId, capabilityId: scenario.capability }), null)
        assert.deepEqual(await prepared.drafts.get(tenantId, prepared.policyKey), prepared.reviewed)
      }

      const duplicateChain: CompiledEnforcementChain = {
        chain_id: "chain-duplicate-candidates",
        tenant_id: tenantId,
        resource_id: resourceId,
        capability_id: "duplicate",
        eligible_connection_ids: ["connection-a", "connection-a"],
        one_policy_revision: 1,
        steps: steps(),
        request_filter_order: ["authorize"],
        response_filter_order: [],
      }
      await assert.rejects(
        store.save({ tenantId, chain: duplicateChain }),
        (error: unknown) => errorCode(error) === "DUPLICATE_ENFORCEMENT_CONNECTION_CANDIDATE",
      )
      assert.equal(await store.getLatest({ tenantId, resourceId, capabilityId: "duplicate" }), null)

      const reversed = await createReviewedDraft(fixture.sql, "reversed", ["connection-z", "connection-a"])
      const published = await store.publishDraft({
        tenantId,
        resourceId,
        capabilityId: "reversed",
        expectedVersion: reversed.reviewed.version,
        expectedContentDigest: reversed.reviewed.content_digest,
        publishedBySubjectId: "publisher",
        correlationId: "reversed-publish",
      })
      assert.deepEqual(published.chain.eligible_connection_ids, ["connection-z", "connection-a"])
      assert.equal(await reversed.drafts.get(tenantId, reversed.policyKey), null)

      const fallback = await createReviewedDraft(fixture.sql, "fallback")
      const fallbackPublished = await store.publishDraft({
        tenantId,
        resourceId,
        capabilityId: "fallback",
        expectedVersion: fallback.reviewed.version,
        expectedContentDigest: fallback.reviewed.content_digest,
        publishedBySubjectId: "publisher",
        correlationId: "fallback-publish",
      })
      assert.deepEqual(fallbackPublished.chain.eligible_connection_ids, ["connection-a", "connection-z"])
      assert.equal(await fallback.drafts.get(tenantId, fallback.policyKey), null)
    } finally {
      await cleanup(fixture)
    }
  },
)

test(
  "PostgreSQL publishDraft rolls back the revision and draft when audit fails",
  { skip: !persistenceTestEnabled || !persistenceUrl, timeout: 30_000 },
  async () => {
    const fixture = await createFixture()
    try {
      const persistedAudit = createPostgresGatewayAuthorizationAuditStore({ sql: fixture.sql })
      let failNext = true
      const audit: GatewayAuthorizationAuditStore = {
        ...persistedAudit,
        async recordInTransaction(input) {
          if (failNext) {
            failNext = false
            throw new Error("AUDIT_WRITE_FAILED")
          }
          return persistedAudit.recordInTransaction!(input)
        },
      }
      const store = createPostgresEnforcementChainRevisionStore({
        sql: fixture.sql,
        audit,
        now: () => 1_700_000_010,
      })
      const prepared = await createReviewedDraft(fixture.sql, "audit-failure", ["connection-a"])
      const publishInput = {
        tenantId,
        resourceId,
        capabilityId: "audit-failure",
        expectedVersion: prepared.reviewed.version,
        expectedContentDigest: prepared.reviewed.content_digest,
        publishedBySubjectId: "publisher",
        correlationId: "audit-failure-publish",
      }

      await assert.rejects(store.publishDraft(publishInput), /AUDIT_WRITE_FAILED/)
      assert.equal(await store.getLatest(publishInput), null)
      assert.deepEqual(await prepared.drafts.get(tenantId, prepared.policyKey), prepared.reviewed)
      const afterFailure = await persistedAudit.query({ tenantId, correlationId: publishInput.correlationId, offset: 0, limit: 10 })
      assert.equal(afterFailure.events.length, 0)

      const published = await store.publishDraft(publishInput)
      assert.equal(published.one_policy_revision, 1)
      assert.equal(await prepared.drafts.get(tenantId, prepared.policyKey), null)
      const afterSuccess = await persistedAudit.query({ tenantId, correlationId: publishInput.correlationId, offset: 0, limit: 10 })
      assert.equal(afterSuccess.events.filter((event) => event.kind === "POLICY_CHANGE").length, 1)
    } finally {
      await cleanup(fixture)
    }
  },
)

test(
  "PostgreSQL system save wins the aggregate revision race and replays without a second audit",
  { skip: !persistenceTestEnabled || !persistenceUrl, timeout: 30_000 },
  async () => {
    const fixture = await createFixture()
    try {
      const persistedAudit = createPostgresGatewayAuthorizationAuditStore({ sql: fixture.sql })
      const systemAuditEntered = deferred<void>()
      const allowSystemAudit = deferred<void>()
      const systemCorrelationId = `policy-system-${resourceId}-race-1`
      let systemAuditRecordCalls = 0
      const audit: GatewayAuthorizationAuditStore = {
        ...persistedAudit,
        async recordInTransaction(input) {
          if (
            input.event.kind === "POLICY_CHANGE" &&
            input.event.action === "SYSTEM_PUBLISHED" &&
            input.event.correlation_id === systemCorrelationId
          ) {
            systemAuditRecordCalls += 1
            if (systemAuditRecordCalls === 1) {
              systemAuditEntered.resolve()
              await allowSystemAudit.promise
            }
          }
          return persistedAudit.recordInTransaction!(input)
        },
      }
      const store = createPostgresEnforcementChainRevisionStore({
        sql: fixture.sql,
        audit,
        now: () => 1_700_000_010,
      })
      const prepared = await createReviewedDraft(fixture.sql, "race", ["connection-a"])
      const systemChain = compileValidatedEnforcementChain({
        tenantId,
        value: {
          resource_id: resourceId,
          capability_id: "race",
          eligible_connection_ids: ["connection-a"],
          one_policy_revision: 1,
          steps: steps(),
        },
      })
      const systemSave = store.save({ tenantId, chain: systemChain })
      await systemAuditEntered.promise

      const humanPublish = store.publishDraft({
        tenantId,
        resourceId,
        capabilityId: "race",
        expectedVersion: prepared.reviewed.version,
        expectedContentDigest: prepared.reviewed.content_digest,
        publishedBySubjectId: "publisher",
        correlationId: "race-human-publish",
      })
      const humanProgress = await Promise.race([
        humanPublish.then(() => "completed" as const, () => "failed" as const),
        wait(100).then(() => "blocked" as const),
      ])
      assert.equal(humanProgress, "blocked")

      allowSystemAudit.resolve()
      const systemRevision = await systemSave
      await assert.rejects(
        humanPublish,
        (error: unknown) => errorCode(error) === "POLICY_REVISION_CONFLICT",
      )
      assert.equal(systemRevision.published_by_subject_id, "system")
      assert.equal(systemRevision.reviewed_by_subject_id, null)
      assert.deepEqual(
        await store.getLatest({ tenantId, resourceId, capabilityId: "race" }),
        systemRevision,
      )
      assert.deepEqual(await prepared.drafts.get(tenantId, prepared.policyKey), prepared.reviewed)

      const systemEvents = await persistedAudit.query({
        tenantId,
        correlationId: systemCorrelationId,
        offset: 0,
        limit: 10,
      })
      assert.equal(systemEvents.events.filter((event) => event.kind === "POLICY_CHANGE").length, 1)
      const humanEvents = await persistedAudit.query({
        tenantId,
        correlationId: "race-human-publish",
        offset: 0,
        limit: 10,
      })
      assert.equal(humanEvents.events.length, 0)

      const replay = await store.save({ tenantId, chain: systemChain })
      assert.deepEqual(replay, systemRevision)
      assert.equal(systemAuditRecordCalls, 1)
      const replayEvents = await persistedAudit.query({
        tenantId,
        correlationId: systemCorrelationId,
        offset: 0,
        limit: 10,
      })
      assert.equal(replayEvents.events.filter((event) => event.kind === "POLICY_CHANGE").length, 1)
    } finally {
      await cleanup(fixture)
    }
  },
)
