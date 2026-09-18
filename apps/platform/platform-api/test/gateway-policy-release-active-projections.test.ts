import assert from "node:assert/strict"
import test from "node:test"

import {
  createPostgresGatewayActiveProjectionSetSource,
} from "../src/capabilities/gateway-policy-release/active-projections"
import type { GatewayProjection } from "../src/capabilities/gateway-projection/contract"
import type { SqlQueryResult, SqlTransaction } from "../src/persistence/sql-adapter"

type Row = Record<string, unknown>

function projection(
  publicationId: string,
  projectionId: string,
  resourceId: string,
  gatewayId = "ai-gateway",
): GatewayProjection {
  return {
    schema_version: "genio.one.gateway.v1",
    operation: "APPLY",
    projection_id: projectionId,
    tenant_id: "tenant-acme",
    publication_id: publicationId,
    resource_id: resourceId,
    capability_id: "chat",
    endpoint_revision: 1,
    policy_revision: 1,
    revision: 1,
    digest: "a".repeat(64),
    signature: { algorithm: "Ed25519", key_id: "projection-key", value: "A".repeat(86) },
    publication_endpoint: {
      gateway_id: gatewayId,
      hostname: `${resourceId}.example.com`,
      base_path: "/",
    },
    policy_bundle: {
      enforcement_chain: {
        chain_id: `chain-${resourceId}`,
        tenant_id: "tenant-acme",
        resource_id: resourceId,
        capability_id: "chat",
        eligible_connection_ids: [`connection-${resourceId}`],
        one_policy_revision: 1,
        steps: [],
        request_filter_order: [],
        response_filter_order: [],
      },
    },
    resources: [{
      apiVersion: "gateway.envoyproxy.io/v1alpha1",
      kind: "AIServiceBackend",
      metadata: { name: `backend-${resourceId}` },
      spec: { schema: { name: "OpenAI" } },
    }],
  }
}

class ActiveProjectionTransaction implements SqlTransaction {
  readonly calls: Array<{ text: string; parameters: readonly unknown[] }> = []

  constructor(readonly rows: Row[]) {}

  async query<Result extends Row = Row>(
    text: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlQueryResult<Result>> {
    this.calls.push({ text, parameters })
    if (text.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 }
    if (text.includes("select distinct projection.resource_id")) {
      const resources = this.rows.map((row) => {
        const payload = typeof row.payload === "string" ? JSON.parse(row.payload) as Row : row.payload as Row
        return { resource_id: payload.resource_id } as unknown as Result
      })
      return { rows: resources, rowCount: resources.length }
    }
    if (text.includes("from genio_one_resources")) {
      const resourceIds = parameters[1]
      return {
        rows: Array.isArray(resourceIds)
          ? resourceIds.map((resource_id) => ({ resource_id }) as unknown as Result)
          : [],
        rowCount: Array.isArray(resourceIds) ? resourceIds.length : 0,
      }
    }
    return { rows: this.rows as Result[], rowCount: this.rows.length }
  }
}

test("locks one Gateway and returns its complete deterministic projection set", async () => {
  const transaction = new ActiveProjectionTransaction([
    { payload: projection("publication-z", "projection-z", "resource-z") },
    { payload: JSON.stringify(projection("publication-a", "projection-a", "resource-a")) },
  ])
  const source = createPostgresGatewayActiveProjectionSetSource()

  const result = await source.listActiveForGatewayInTransaction({
    transaction,
    tenantId: "tenant-acme",
    gatewayId: "ai-gateway",
    candidate: projection("publication-m", "projection-m", "resource-m"),
  })

  assert.deepEqual(result.map((value) => value.publication_id), [
    "publication-a",
    "publication-m",
    "publication-z",
  ])
  assert.match(transaction.calls[0]!.text, /pg_advisory_xact_lock/)
  assert.deepEqual(transaction.calls[0]!.parameters, ["tenant:tenant-acme|gateway:ai-gateway"])
  assert.match(
    transaction.calls[3]!.text,
    /publication_state in \('PUBLISHED', 'DEPRECATED'\)/,
  )
  assert.match(transaction.calls[2]!.text, /from genio_one_resources/)
  assert.match(transaction.calls[2]!.text, /for update/)
  assert.deepEqual(transaction.calls[2]!.parameters, ["tenant-acme", ["resource-a", "resource-m", "resource-z"]])
  assert.match(transaction.calls[3]!.text, /projection\.resource_id <> \$3/)
  assert.match(transaction.calls[3]!.text, /for update of publication, projection/)
  assert.deepEqual(transaction.calls[3]!.parameters, ["tenant-acme", "ai-gateway", "resource-m", "chat"])
})

test("reconciliation can produce an empty active projection set", async () => {
  const transaction = new ActiveProjectionTransaction([])
  const source = createPostgresGatewayActiveProjectionSetSource()

  const result = await source.listActiveForGatewayInTransaction({
    transaction,
    tenantId: "tenant-acme",
    gatewayId: "ai-gateway",
  })

  assert.deepEqual(result, [])
  assert.match(transaction.calls[0]!.text, /pg_advisory_xact_lock/)
  assert.match(
    transaction.calls[2]!.text,
    /publication_state in \('PUBLISHED', 'DEPRECATED'\)/,
  )
})

test("rejects a candidate outside the locked tenant or Gateway before querying", async () => {
  const transaction = new ActiveProjectionTransaction([])
  const source = createPostgresGatewayActiveProjectionSetSource()

  await assert.rejects(
    source.listActiveForGatewayInTransaction({
      transaction,
      tenantId: "tenant-acme",
      gatewayId: "ai-gateway",
      candidate: projection("publication-a", "projection-a", "resource-a", "api-gateway"),
    }),
    /GATEWAY_ACTIVE_PROJECTION_MISMATCH/,
  )
  assert.equal(transaction.calls.length, 0)
})

test("fails closed on invalid persisted payloads and ambiguous active membership", async () => {
  const source = createPostgresGatewayActiveProjectionSetSource()
  const invalid = new ActiveProjectionTransaction([{ payload: { operation: "APPLY" } }])
  await assert.rejects(
    source.listActiveForGatewayInTransaction({
      transaction: invalid,
      tenantId: "tenant-acme",
      gatewayId: "ai-gateway",
      candidate: projection("publication-m", "projection-m", "resource-m"),
    }),
    /GATEWAY_ACTIVE_PROJECTION_INVALID/,
  )

  const ambiguous = new ActiveProjectionTransaction([
    { payload: projection("publication-a", "projection-a", "resource-shared") },
  ])
  await assert.rejects(
    source.listActiveForGatewayInTransaction({
      transaction: ambiguous,
      tenantId: "tenant-acme",
      gatewayId: "ai-gateway",
      candidate: projection("publication-b", "projection-b", "resource-shared"),
    }),
    /GATEWAY_ACTIVE_PROJECTION_AMBIGUOUS/,
  )
})
