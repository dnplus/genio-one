import assert from "node:assert/strict"
import test from "node:test"

import Fastify from "fastify"

import { modelEntitlementHttp } from "../src/capabilities/entitlements/http"
import { createInMemoryModelEntitlementCatalog } from "../src/capabilities/entitlements/memory"
import { createPostgresModelEntitlementCatalog } from "../src/capabilities/entitlements/postgres"
import { PlatformApiError } from "../src/capabilities/errors"
import type { SqlAdapter, SqlQueryResult } from "../src/persistence/sql-adapter"

test("model entitlements bind subject/client and expire without widening candidates", async () => {
  let currentTime = 100
  const catalog = createInMemoryModelEntitlementCatalog({
    now: () => currentTime,
    idFactory: (sequence) => `grant-${sequence}`,
  })
  await catalog.grant({
    tenantId: "tenant-acme",
    value: {
      subject_id: "person-1",
      client_id: "app-1",
      resource_id: "resource-ai",
      capability_id: "model.invoke",
      public_model_id: "model-opus",
      expires_at: 200,
    },
  })
  await catalog.grant({
    tenantId: "tenant-acme",
    value: {
      subject_id: "person-2",
      resource_id: "resource-ai",
      capability_id: "model.invoke",
      public_model_id: "model-gpt",
    },
  })

  assert.deepEqual(await catalog.resolve({
    tenantId: "tenant-acme",
    subjectId: "person-1",
    clientId: "app-1",
  }), ["model-opus"])
  assert.deepEqual(await catalog.resolve({
    tenantId: "tenant-acme",
    subjectId: "person-1",
    clientId: "app-other",
  }), [])

  currentTime = 200
  assert.deepEqual(await catalog.resolve({
    tenantId: "tenant-acme",
    subjectId: "person-1",
    clientId: "app-1",
  }), [])
})

test("model entitlement requires an identity boundary and supports revocation", async () => {
  const catalog = createInMemoryModelEntitlementCatalog({ now: () => 100 })
  await assert.rejects(
    catalog.grant({
      tenantId: "tenant-acme",
      value: {
        resource_id: "resource-ai",
        capability_id: "model.invoke",
        public_model_id: "model-opus",
      },
    }),
    (error: unknown) =>
      error instanceof PlatformApiError && error.code === "ENTITLEMENT_PRINCIPAL_REQUIRED",
  )
  const grant = await catalog.grant({
    tenantId: "tenant-acme",
    value: {
      subject_id: "person-1",
      resource_id: "resource-ai",
      capability_id: "model.invoke",
      public_model_id: "model-opus",
    },
  })
  await catalog.revoke({
    tenantId: "tenant-acme",
    entitlementId: grant.entitlement_id,
  })
  assert.deepEqual(await catalog.resolve({
    tenantId: "tenant-acme",
    subjectId: "person-1",
    clientId: "app-1",
  }), [])
})

test("model entitlement grant retries reuse the exact request and expired grants can renew", async () => {
  let currentTime = 100
  const catalog = createInMemoryModelEntitlementCatalog({
    now: () => currentTime,
    idFactory: (sequence) => `grant-${sequence}`,
  })
  const input = {
    subject_id: "person-1",
    resource_id: "resource-ai",
    capability_id: "model.invoke",
    public_model_id: "model-opus",
    expires_at: 200,
  }

  const first = await catalog.grant({
    tenantId: "tenant-acme",
    value: input,
    idempotencyKey: "retry-1",
  })
  const retried = await catalog.grant({
    tenantId: "tenant-acme",
    value: input,
    idempotencyKey: "retry-1",
  })

  assert.equal(retried.entitlement_id, first.entitlement_id)
  assert.equal((await catalog.list({ tenantId: "tenant-acme" })).length, 1)

  currentTime = 201
  const replayedAfterExpiry = await catalog.grant({
    tenantId: "tenant-acme",
    value: input,
    idempotencyKey: "retry-1",
  })
  const renewed = await catalog.grant({
    tenantId: "tenant-acme",
    value: { ...input, expires_at: 300 },
    idempotencyKey: "retry-2",
  })
  const scoped = await catalog.grant({
    tenantId: "tenant-acme",
    value: { ...input, client_id: "app-1", expires_at: 300 },
    idempotencyKey: "retry-3",
  })
  const modelScoped = await catalog.grant({
    tenantId: "tenant-acme",
    value: { ...input, public_model_id: "model-gpt", expires_at: 300 },
    idempotencyKey: "retry-4",
  })

  assert.equal(replayedAfterExpiry.entitlement_id, first.entitlement_id)
  assert.notEqual(renewed.entitlement_id, first.entitlement_id)
  assert.notEqual(scoped.entitlement_id, renewed.entitlement_id)
  assert.notEqual(modelScoped.entitlement_id, renewed.entitlement_id)
  assert.equal(
    (await catalog.list({ tenantId: "tenant-acme" })).filter((value) => value.state === "ACTIVE").length,
    4,
  )
  await assert.rejects(
    catalog.grant({
      tenantId: "tenant-acme",
      value: { ...input, client_id: "app-1" },
      idempotencyKey: "retry-1",
    }),
    (error: unknown) =>
      error instanceof PlatformApiError && error.code === "ENTITLEMENT_IDEMPOTENCY_KEY_REUSED",
  )
})

test("entitlement HTTP forwards the retry request identity", async () => {
  const grant = {
    tenant_id: "tenant-acme",
    entitlement_id: "entitlement-1",
    subject_id: "person-1",
    client_id: null,
    resource_id: "resource-ai",
    capability_id: "model.invoke",
    public_model_id: null,
    state: "ACTIVE" as const,
    starts_at: 100,
    expires_at: null,
    created_at: 100,
  }
  let received: string | undefined
  const app = Fastify()
  await app.register(modelEntitlementHttp, {
    catalog: {
      async list() {
        return []
      },
      async grant(input) {
        received = input.idempotencyKey
        return grant
      },
      async revoke() {
        return grant
      },
      async resolve() {
        return []
      },
    },
  })

  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/tenants/tenant-acme/entitlements",
      headers: { "idempotency-key": "retry-1" },
      payload: {
        subject_id: "person-1",
        resource_id: "resource-ai",
        capability_id: "model.invoke",
      },
    })
    assert.equal(response.statusCode, 201)
    assert.equal(received, "retry-1")
  } finally {
    await app.close()
  }
})

test("PostgreSQL entitlement resolution orders by its selected Public Model", async () => {
  let query = ""
  const sql: SqlAdapter = {
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
    ): Promise<SqlQueryResult<Row>> {
      query = text
      return {
        rows: [{ public_model_id: "model-public" } as unknown as Row],
        rowCount: 1,
      }
    },
    async transaction(work) {
      return work(this)
    },
  }
  const catalog = createPostgresModelEntitlementCatalog({ sql })

  assert.deepEqual(await catalog.resolve({
    tenantId: "tenant-acme",
    subjectId: "person-1",
    clientId: "app-1",
  }), ["model-public"])
  assert.match(query, /order by model\.model_id/)
})

test("PostgreSQL entitlement grant reuses only the same retry request", async () => {
  const queries: string[] = []
  const rows: Array<Record<string, unknown>> = []
  let currentTime = 100
  const sql: SqlAdapter = {
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      parameters: readonly unknown[] = [],
    ): Promise<SqlQueryResult<Row>> {
      queries.push(text)
      if (text.includes("from genio_one_model_entitlements") && text.includes("grant_idempotency_key")) {
        const row = rows.find((candidate) =>
          candidate.tenant_id === parameters[0]
          && candidate.grant_idempotency_key === parameters[1],
        )
        return { rows: row ? [row as unknown as Row] : [], rowCount: row ? 1 : 0 }
      }
      if (text.includes("insert into genio_one_model_entitlements")) {
        const row: Record<string, unknown> = {
          tenant_id: parameters[0],
          entitlement_id: parameters[1],
          subject_id: parameters[2],
          client_id: parameters[3],
          resource_id: parameters[4],
          capability_id: parameters[5],
          public_model_id: parameters[6],
          state: "ACTIVE",
          starts_at: parameters[7],
          expires_at: parameters[8],
          grant_idempotency_key: parameters[9],
          grant_request_digest: parameters[10],
          created_at: 100,
        }
        if (rows.some((candidate) =>
          candidate.tenant_id === row.tenant_id
          && candidate.grant_idempotency_key === row.grant_idempotency_key
          && row.grant_idempotency_key !== null,
        )) {
          return { rows: [], rowCount: 0 }
        }
        rows.push(row)
        return { rows: [row as unknown as Row], rowCount: 1 }
      }
      if (text.includes("from genio_one_publications")) return { rows: [], rowCount: 0 }
      throw new Error(`Unexpected SQL query: ${text}`)
    },
    async transaction(work) {
      return work(this)
    },
  }
  const catalog = createPostgresModelEntitlementCatalog({
    sql,
    now: () => currentTime,
    idFactory: (() => {
      let sequence = 0
      return () => `entitlement-${++sequence}`
    })(),
  })
  const input = {
    subject_id: "person-1",
    resource_id: "resource-ai",
    capability_id: "model.invoke",
    public_model_id: "model-opus",
    expires_at: 200,
  }

  const first = await catalog.grant({
    tenantId: "tenant-acme",
    value: input,
    idempotencyKey: "retry-1",
  })
  currentTime = 201
  const retried = await catalog.grant({
    tenantId: "tenant-acme",
    value: input,
    idempotencyKey: "retry-1",
  })
  const distinct = await catalog.grant({
    tenantId: "tenant-acme",
    value: { ...input, client_id: "app-1", expires_at: 300 },
    idempotencyKey: "retry-2",
  })
  const modelScoped = await catalog.grant({
    tenantId: "tenant-acme",
    value: { ...input, public_model_id: "model-gpt", expires_at: 300 },
    idempotencyKey: "retry-3",
  })

  assert.equal(retried.entitlement_id, first.entitlement_id)
  assert.notEqual(distinct.entitlement_id, first.entitlement_id)
  assert.notEqual(modelScoped.entitlement_id, first.entitlement_id)
  assert.equal(queries.filter((query) => query.includes("insert into genio_one_model_entitlements")).length, 3)
  assert.ok(queries.some((query) => query.includes("on conflict (tenant_id, grant_idempotency_key)")))
  assert.ok(!queries.some((query) => query.includes("is not distinct from")))
  await assert.rejects(
    catalog.grant({
      tenantId: "tenant-acme",
      value: { ...input, client_id: "app-1", expires_at: 300 },
      idempotencyKey: "retry-1",
    }),
    (error: unknown) =>
      error instanceof PlatformApiError && error.code === "ENTITLEMENT_IDEMPOTENCY_KEY_REUSED",
  )
})
