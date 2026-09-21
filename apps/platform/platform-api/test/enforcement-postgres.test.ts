import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"

import { PlatformApiError } from "../src/capabilities/errors"
import type { CompiledEnforcementChain } from "../src/capabilities/enforcement/contract"
import {
  createPostgresEnforcementChainRevisionStore,
} from "../src/capabilities/enforcement/postgres"
import { canonicalEnforcementChainDigest } from "../src/capabilities/enforcement/compiler"
import { lockGatewayPolicyRelease } from "../src/capabilities/gateway-policy-release/transaction-lock"
import { createPostgresSqlAdapter } from "../src/persistence/sql-adapter"
import type { SqlAdapter, SqlQueryResult, SqlTransaction } from "../src/persistence/sql-adapter"

type Row = Record<string, unknown>

const jwt = {
  schema_version: "genio.one.auth.jwt.v1" as const,
  provider: "keycloak",
  issuer: "https://identity.example.test/realms/acme",
  audiences: ["genio-one"],
  remote_jwks_uri: "https://identity.example.test/realms/acme/protocol/openid-connect/certs",
  subject_claim: "sub",
  client_claim: "azp",
}

const chain: CompiledEnforcementChain = {
  chain_id: "chain-compiled",
  tenant_id: "tenant-acme",
  resource_id: "resource-ai",
  capability_id: "chat",
  eligible_connection_ids: ["connection-openai", "connection-ollama"],
  one_policy_revision: 7,
  steps: [
    {
      step_id: "authenticate",
      kind: "AUTHENTICATE",
      phase: "REQUEST",
      implementation: "NATIVE",
      config: jwt,
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
  request_filter_order: ["authorize"],
  response_filter_order: [],
}

function key(values: readonly unknown[]): string {
  return values.slice(0, 4).map(String).join("\u001f")
}

class FakeSqlAdapter implements SqlAdapter, SqlTransaction {
  readonly calls: Array<{ text: string; parameters: readonly unknown[] }> = []
  private readonly rows = new Map<string, Row>()
  private publication: Row | null = null

  async query<Result extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlQueryResult<Result>> {
    this.calls.push({ text, parameters })
    if (text.includes("insert into genio_one_enforcement_chain_revisions")) {
      const rowKey = key(parameters)
      if (this.rows.has(rowKey)) return { rows: [], rowCount: 0 }
      const row: Row = {
        tenant_id: parameters[0],
        resource_id: parameters[1],
        capability_id: parameters[2],
        one_policy_revision: parameters[3],
        eligible_connection_ids: JSON.parse(String(parameters[4])) as unknown,
        chain: JSON.parse(String(parameters[5])) as unknown,
        chain_digest: parameters[6],
        created_at: 1_700_000_000,
        updated_at: 1_700_000_000,
      }
      this.rows.set(rowKey, row)
      return { rows: [row as Result], rowCount: 1 }
    }
    if (text.includes("from genio_one_publications")) {
      return this.publication
        ? { rows: [this.publication as Result], rowCount: 1 }
        : { rows: [], rowCount: 0 }
    }
    if (text.includes("from genio_one_enforcement_chain_revisions")) {
      if (text.includes("distinct on (resource_id, capability_id)")) {
        return {
          rows: [...this.rows.values()] as Result[],
          rowCount: this.rows.size,
        }
      }
      const row = this.rows.get(key(parameters))
      return row
        ? { rows: [row as Result], rowCount: 1 }
        : { rows: [], rowCount: 0 }
    }
    return { rows: [], rowCount: 0 }
  }

  async transaction<T>(work: (transaction: SqlTransaction) => Promise<T>): Promise<T> {
    return work(this)
  }

  seed(row: Row): void {
    this.rows.set(key([
      row.tenant_id,
      row.resource_id,
      row.capability_id,
      row.one_policy_revision,
    ]), row)
  }

  seedPublication(row: Row): void {
    this.publication = row
  }
}

function errorCode(error: unknown): string | null {
  return error instanceof PlatformApiError ? error.code : null
}

function deferred(): {
  promise: Promise<void>
  resolve: () => void
} {
  let resolve: (() => void) | undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve: () => resolve?.() }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

test("Postgres Enforcement Chain store saves and retrieves a tenant-scoped revision", async () => {
  const sql = new FakeSqlAdapter()
  const store = createPostgresEnforcementChainRevisionStore({ sql })

  const saved = await store.save({ tenantId: "tenant-acme", chain })
  assert.equal(saved.tenant_id, "tenant-acme")
  assert.equal(saved.capability_id, "chat")
  assert.deepEqual(saved.chain.eligible_connection_ids, [
    "connection-openai",
    "connection-ollama",
  ])
  assert.equal(saved.chain_digest, canonicalEnforcementChainDigest(chain))

  const loaded = await store.get({
    tenantId: "tenant-acme",
    resourceId: "resource-ai",
    capabilityId: "chat",
    onePolicyRevision: 7,
  })
  assert.deepEqual(loaded, saved)

  const select = sql.calls.find((call) =>
    call.text.includes("from genio_one_enforcement_chain_revisions"),
  )
  assert.ok(select)
  assert.equal(select.text.includes("tenant-acme"), false)
  assert.deepEqual(select.parameters, ["tenant-acme", "resource-ai", "chat", 7])
  const insert = sql.calls.find((call) =>
    call.text.includes("insert into genio_one_enforcement_chain_revisions"),
  )
  assert.ok(insert)
  assert.match(insert.text, /eligible_connection_ids/i)
  assert.match(insert.text, /\$5::text::jsonb/)
  assert.match(insert.text, /\$6::text::jsonb/)
})

test("same chain identity and canonical digest is idempotent", async () => {
  const sql = new FakeSqlAdapter()
  const store = createPostgresEnforcementChainRevisionStore({ sql })
  const first = await store.save({ tenantId: "tenant-acme", chain })

  const reordered = {
    ...chain,
    steps: chain.steps.map((step) => {
      const entries = Object.entries(step).reverse()
      return Object.fromEntries(entries) as typeof step
    }),
  } as CompiledEnforcementChain
  assert.equal(canonicalEnforcementChainDigest(reordered), first.chain_digest)
  const replay = await store.save({ tenantId: "tenant-acme", chain: reordered })
  assert.deepEqual(replay, first)
})

test("published enforcement chain saves lock its Gateway before the Resource foreign-key insert", async () => {
  const sql = new FakeSqlAdapter()
  sql.seedPublication({
    gateway_id: "gateway-acme",
    publication_state: "PUBLISHED",
  })
  const releases: string[] = []
  const store = createPostgresEnforcementChainRevisionStore({
    sql,
    releasePublisher: {
      async reconcileInTransaction(input) {
        releases.push(input.gatewayId)
      },
    },
  })

  await store.save({ tenantId: "tenant-acme", chain })

  const publicationReads = sql.calls
    .map((call, index) => ({ call, index }))
    .filter(({ call }) => call.text.includes("from genio_one_publications"))
  const gatewayLock = sql.calls.findIndex((call) =>
    call.text.includes("pg_advisory_xact_lock") && call.parameters[0] === "tenant:tenant-acme|gateway:gateway-acme",
  )
  const insert = sql.calls.findIndex((call) =>
    call.text.includes("insert into genio_one_enforcement_chain_revisions"),
  )
  assert.equal(publicationReads.length, 2)
  assert.ok(publicationReads[0]!.index < gatewayLock)
  assert.ok(gatewayLock < insert)
  assert.ok(insert < publicationReads[1]!.index)
  assert.deepEqual(releases, ["gateway-acme"])
})

test("same chain identity with different content is immutable and returns conflict", async () => {
  const sql = new FakeSqlAdapter()
  const store = createPostgresEnforcementChainRevisionStore({ sql })
  await store.save({ tenantId: "tenant-acme", chain })
  const changed = {
    ...chain,
    eligible_connection_ids: ["connection-ollama", "connection-openai"],
  }

  await assert.rejects(
    store.save({ tenantId: "tenant-acme", chain: changed }),
    (error: unknown) => errorCode(error) === "ENFORCEMENT_CHAIN_REVISION_IMMUTABLE",
  )
})

test("cross-tenant chain identity and duplicate candidates fail closed", async () => {
  const sql = new FakeSqlAdapter()
  const store = createPostgresEnforcementChainRevisionStore({ sql })

  await assert.rejects(
    store.save({ tenantId: "tenant-other", chain }),
    (error: unknown) => errorCode(error) === "ENFORCEMENT_CHAIN_SCOPE_MISMATCH",
  )

  const duplicateCandidates = {
    ...chain,
    eligible_connection_ids: ["connection-openai", "connection-openai"],
  }
  await assert.rejects(
    store.save({ tenantId: "tenant-acme", chain: duplicateCandidates }),
    (error: unknown) =>
      errorCode(error) === "DUPLICATE_ENFORCEMENT_CONNECTION_CANDIDATE",
  )

  const otherTenant = await store.get({
    tenantId: "tenant-other",
    resourceId: "resource-ai",
    capabilityId: "chat",
    onePolicyRevision: 7,
  })
  assert.equal(otherTenant, null)
})

test("Postgres Enforcement Chain store rejects semantically stale compiled order", async () => {
  const sql = new FakeSqlAdapter()
  const store = createPostgresEnforcementChainRevisionStore({ sql })

  await assert.rejects(
    store.save({
      tenantId: "tenant-acme",
      chain: { ...chain, request_filter_order: [] },
    }),
    (error: unknown) =>
      errorCode(error) === "ENFORCEMENT_REQUEST_FILTER_ORDER_INVALID",
  )
  assert.equal(sql.calls.length, 0)
})

test("inventory preserves valid chains and isolates legacy rows that require migration", async () => {
  const sql = new FakeSqlAdapter()
  const store = createPostgresEnforcementChainRevisionStore({ sql })
  await store.save({ tenantId: "tenant-acme", chain })
  sql.seed({
    tenant_id: "tenant-acme",
    resource_id: "resource-legacy",
    capability_id: "chat",
    one_policy_revision: 3,
    chain: {
      chain_id: "legacy-chain",
      tenant_id: "tenant-acme",
      resource_id: "resource-legacy",
      capability_id: "chat",
      eligible_connection_ids: ["connection-legacy"],
      one_policy_revision: 3,
      steps: [],
      request_filter_order: [],
      response_filter_order: [],
    },
    chain_digest: "0".repeat(64),
    created_at: 1_700_000_000,
    updated_at: 1_700_000_000,
  })

  const inventory = await store.listInventory({ tenantId: "tenant-acme" })
  assert.deepEqual(inventory.map((item) => ({
    resource_id: item.resource_id,
    status: item.status,
    issue_code: item.issue_code,
  })), [
    {
      resource_id: "resource-ai",
      status: "READY",
      issue_code: null,
    },
    {
      resource_id: "resource-legacy",
      status: "MIGRATION_REQUIRED",
      issue_code: "ENFORCEMENT_CHAIN_DATA_INVALID",
    },
  ])
})

const persistenceUrl =
  process.env.GENIO_ONE_TEST_DATABASE_URL ?? process.env.GENIO_ONE_DATABASE_URL
const persistenceTestEnabled =
  process.env.GENIO_ONE_PUBLICATION_PERSISTENCE_TEST === "1" ||
  Boolean(process.env.GENIO_ONE_TEST_DATABASE_URL)

test(
  "PostgreSQL published chain save waits for Gateway before its Resource foreign-key lock",
  { skip: !persistenceTestEnabled || !persistenceUrl, timeout: 15_000 },
  async () => {
    assert.ok(persistenceUrl)
    assert.ok(["localhost", "127.0.0.1"].includes(new URL(persistenceUrl).hostname))
    const schema = `enforcementlockqa_${randomUUID().replaceAll("-", "")}`
    const setup = createPostgresSqlAdapter({ url: persistenceUrl })
    const sql = createPostgresSqlAdapter({
      url: persistenceUrl,
      options: { max: 2, connection: { search_path: schema } },
    })
    const tenantId = `tenant-enforcement-lock-${randomUUID()}`
    const resourceId = `resource-enforcement-lock-${randomUUID()}`
    const gatewayId = `gateway-enforcement-lock-${randomUUID()}`
    const gatewayHeld = deferred()
    const allowResourceLock = deferred()
    const resourceLocked = deferred()
    const releaseCoordinator = deferred()
    const releaseEntered = deferred()
    let releaseCalls = 0

    try {
      await setup.query(`create schema ${schema}`)
      await sql.query(`
        create table genio_one_resources (
          tenant_id text not null,
          resource_id text not null,
          primary key (tenant_id, resource_id)
        );
        create table genio_one_publications (
          tenant_id text not null,
          resource_id text not null,
          endpoint_revision bigint not null,
          gateway_id text,
          publication_state text not null
        );
        create table genio_one_enforcement_chain_revisions (
          tenant_id text not null,
          resource_id text not null,
          capability_id text not null,
          one_policy_revision bigint not null,
          eligible_connection_ids jsonb not null,
          chain jsonb not null,
          chain_digest text not null,
          published_by_subject_id text,
          reviewed_by_subject_id text,
          rollback_source_one_policy_revision bigint,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          primary key (tenant_id, resource_id, capability_id, one_policy_revision),
          foreign key (tenant_id, resource_id)
            references genio_one_resources (tenant_id, resource_id)
        )
      `)
      await sql.query(
        `insert into genio_one_resources (tenant_id, resource_id) values ($1, $2)`,
        [tenantId, resourceId],
      )
      await sql.query(
        `insert into genio_one_publications
           (tenant_id, resource_id, endpoint_revision, gateway_id, publication_state)
         values ($1, $2, 1, $3, 'PUBLISHED')`,
        [tenantId, resourceId, gatewayId],
      )

      const coordinator = sql.transaction(async (transaction) => {
        await lockGatewayPolicyRelease({ transaction, tenantId, gatewayId })
        gatewayHeld.resolve()
        await allowResourceLock.promise
        await transaction.query(
          `select resource_id from genio_one_resources
            where tenant_id = $1 and resource_id = $2
            for update`,
          [tenantId, resourceId],
        )
        resourceLocked.resolve()
        await releaseCoordinator.promise
      })
      await gatewayHeld.promise

      const store = createPostgresEnforcementChainRevisionStore({
        sql,
        now: () => 1_757_000_000,
        releasePublisher: {
          async reconcileInTransaction(input) {
            releaseCalls += 1
            releaseEntered.resolve()
            await lockGatewayPolicyRelease(input)
            await input.transaction.query(
              `select resource_id from genio_one_resources
                where tenant_id = $1 and resource_id = $2
                for update`,
              [tenantId, resourceId],
            )
          },
        },
      })
      const saving = store.save({
        tenantId,
        chain: {
          ...chain,
          tenant_id: tenantId,
          resource_id: resourceId,
          capability_id: `capability-${randomUUID()}`,
        },
      })

      // Before the fix, the insert took the Resource foreign-key key-share
      // lock and entered the release publisher while this coordinator held G.
      // It then deadlocked when the coordinator attempted FOR UPDATE on R.
      const publisherReachedBeforeGatewayReleased = await Promise.race([
        releaseEntered.promise.then(() => true),
        wait(100).then(() => false),
      ])
      assert.equal(publisherReachedBeforeGatewayReleased, false)
      assert.equal(releaseCalls, 0)

      allowResourceLock.resolve()
      await resourceLocked.promise
      releaseCoordinator.resolve()
      await Promise.all([coordinator, saving])
      assert.equal(releaseCalls, 1)
    } finally {
      allowResourceLock.resolve()
      releaseCoordinator.resolve()
      await sql.end({ timeout: 1 })
      await setup.query(`drop schema if exists ${schema} cascade`)
      await setup.end({ timeout: 1 })
    }
  },
)
