import assert from "node:assert/strict"
import test from "node:test"

import { Check } from "typebox/value"

import { PlatformApiError } from "../src/capabilities/errors"
import {
  CreateModelRoutingPolicySchema,
  type CreateModelRoutingPolicyInput,
} from "../src/capabilities/model-routing/contract"
import { createInMemoryModelRoutingPolicyStore } from "../src/capabilities/model-routing/policy-memory"
import { createPostgresModelRoutingPolicyStore } from "../src/capabilities/model-routing/policy-postgres"
import { validateCreateModelRoutingPolicy } from "../src/capabilities/model-routing/policy"
import type { SqlAdapter, SqlQueryResult, SqlTransaction } from "../src/persistence/sql-adapter"

const tenantId = "tenant-acme"
const ownerOrganizationId = "org-ai"

function policyInput(
  overrides: Partial<CreateModelRoutingPolicyInput> = {},
): CreateModelRoutingPolicyInput {
  return {
    owner_organization_id: ownerOrganizationId,
    resource_id: "resource-ai",
    capability_id: "chat",
    routing_revision: 1,
    mode: "DETERMINISTIC",
    candidate_public_model_ids: ["public-gpt", "public-omlx"],
    default_public_model_id: "public-gpt",
    session_lease_seconds: null,
    ...overrides,
  }
}

const persistedRow: Record<string, unknown> = {
  tenant_id: tenantId,
  routing_policy_id: "routing-policy-1",
  owner_organization_id: ownerOrganizationId,
  resource_id: "resource-ai",
  capability_id: "chat",
  routing_revision: 1,
  mode: "DETERMINISTIC",
  default_public_model_id: "public-gpt",
  candidate_public_model_ids: ["public-gpt", "public-omlx"],
  session_lease_seconds: null,
  created_at: 1_700_000_000,
  updated_at: 1_700_000_000,
}

function has(text: string, fragment: string): boolean {
  return text.toLowerCase().includes(fragment.toLowerCase())
}

class FakeSqlAdapter implements SqlAdapter, SqlTransaction {
  readonly calls: Array<{ text: string; parameters: readonly unknown[] }> = []

  constructor(readonly handler: (text: string, parameters: readonly unknown[]) => Record<string, unknown>[] = () => []) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlQueryResult<Row>> {
    this.calls.push({ text, parameters })
    const rows = this.handler(text, parameters) as Row[]
    return { rows, rowCount: rows.length }
  }

  async transaction<T>(work: (transaction: SqlTransaction) => Promise<T>): Promise<T> {
    return work(this)
  }
}

function errorCode(error: unknown): string | null {
  return error instanceof PlatformApiError ? error.code : null
}

test("routing policy schema is strict and validates mode-specific lease semantics", () => {
  const valid = policyInput({
    mode: "SESSION_LEASE",
    session_lease_seconds: 900,
  })
  assert.equal(Check(CreateModelRoutingPolicySchema, valid), true)
  assert.equal(
    Check(CreateModelRoutingPolicySchema, { ...valid, unexpected: true }),
    false,
  )
  assert.equal(
    Check(CreateModelRoutingPolicySchema, {
      ...valid,
      nested: { secret: "must not be accepted" },
    }),
    false,
  )

  assert.throws(
    () => validateCreateModelRoutingPolicy(policyInput({
      mode: "SESSION_LEASE",
      session_lease_seconds: null,
    })),
    (error: unknown) => errorCode(error) === "MODEL_ROUTING_POLICY_SESSION_TTL_REQUIRED",
  )
  assert.throws(
    () => validateCreateModelRoutingPolicy(policyInput({ session_lease_seconds: 900 })),
    (error: unknown) => errorCode(error) === "MODEL_ROUTING_POLICY_SESSION_TTL_FORBIDDEN",
  )
})

test("routing policy requires the default alias and preserves explicit candidate order", () => {
  assert.throws(
    () => validateCreateModelRoutingPolicy(policyInput({ default_public_model_id: "public-unknown" })),
    (error: unknown) => errorCode(error) === "MODEL_ROUTING_POLICY_DEFAULT_NOT_CANDIDATE",
  )
  assert.throws(
    () => validateCreateModelRoutingPolicy(policyInput({
      candidate_public_model_ids: ["public-gpt", "public-gpt"],
    })),
    (error: unknown) =>
      errorCode(error) === "MODEL_ROUTING_POLICY_CANDIDATES_DUPLICATE" ||
      errorCode(error) === "MODEL_ROUTING_POLICY_INVALID",
  )
})

test("memory policy store is organization-scoped and immutable by revision", async () => {
  const owners = new Map([[`${tenantId}:resource-ai`, ownerOrganizationId]])
  const store = createInMemoryModelRoutingPolicyStore({
    now: () => 1_700_000_000,
    idFactory: () => "routing-policy-1",
    resourceOwner: ({ tenantId: currentTenantId, resourceId }) =>
      owners.get(`${currentTenantId}:${resourceId}`) ?? null,
  })

  const first = await store.save({ tenantId, value: policyInput() })
  assert.equal(first.routing_policy_id, "routing-policy-1")
  assert.deepEqual(first.candidate_public_model_ids, ["public-gpt", "public-omlx"])
  first.candidate_public_model_ids.reverse()

  const readBack = await store.get({
    tenantId,
    ownerOrganizationId,
    resourceId: "resource-ai",
    capabilityId: "chat",
    routingRevision: 1,
  })
  assert.deepEqual(readBack?.candidate_public_model_ids, ["public-gpt", "public-omlx"])

  const replay = await store.save({ tenantId, value: policyInput() })
  assert.equal(replay.routing_policy_id, first.routing_policy_id)

  await assert.rejects(
    store.save({
      tenantId,
      value: policyInput({ candidate_public_model_ids: ["public-omlx", "public-gpt"] }),
    }),
    (error: unknown) => errorCode(error) === "MODEL_ROUTING_POLICY_REVISION_CONFLICT",
  )

  const second = await store.save({
    tenantId,
    value: policyInput({ routing_revision: 2, candidate_public_model_ids: ["public-omlx", "public-gpt"], default_public_model_id: "public-omlx" }),
  })
  assert.equal(second.routing_revision, 2)
  assert.equal(second.routing_policy_id, first.routing_policy_id)
  assert.equal(
    (await store.getLatest({
      tenantId,
      ownerOrganizationId,
      resourceId: "resource-ai",
      capabilityId: "chat",
    }))?.routing_revision,
    2,
  )
  assert.equal(
    (await store.list({ tenantId, ownerOrganizationId })).length,
    2,
  )
  assert.equal(
    (await store.list({ tenantId, ownerOrganizationId: "org-other" })).length,
    0,
  )
})

test("memory policy store rejects a policy owned by another organization", async () => {
  const store = createInMemoryModelRoutingPolicyStore({
    resourceOwner: () => "org-other",
  })
  await assert.rejects(
    store.save({ tenantId, value: policyInput() }),
    (error: unknown) =>
      errorCode(error) === "MODEL_ROUTING_POLICY_OWNER_MISMATCH" &&
      (error as PlatformApiError).statusCode === 403,
  )
})

test("Postgres policy adapter checks Resource ownership and stores no provider secrets", async () => {
  const sql = new FakeSqlAdapter((text) => {
    if (has(text, "select owner_organization_id")) return [{ owner_organization_id: ownerOrganizationId }]
    if (has(text, "insert into genio_one_model_routing_policies")) return [persistedRow]
    return []
  })
  const store = createPostgresModelRoutingPolicyStore({
    sql,
    idFactory: () => "routing-policy-1",
  })

  const policy = await store.save({ tenantId, value: policyInput() })
  assert.equal(policy.routing_policy_id, "routing-policy-1")
  const insert = sql.calls.find((call) => has(call.text, "insert into genio_one_model_routing_policies"))
  assert.ok(insert)
  assert.match(insert.text, /\$9::text::jsonb/i)
  assert.match(insert.text, /on conflict \(tenant_id, resource_id, capability_id, routing_revision\)/i)
  assert.equal(insert.text.includes("secret"), false)
  assert.equal(insert.text.includes("credential"), false)
  assert.equal(insert.text.includes("provider_model"), false)
  assert.deepEqual(insert.parameters, [
    tenantId,
    "routing-policy-1",
    ownerOrganizationId,
    "resource-ai",
    "chat",
    1,
    "DETERMINISTIC",
    "public-gpt",
    '["public-gpt","public-omlx"]',
    null,
    "[]",
  ])
})
