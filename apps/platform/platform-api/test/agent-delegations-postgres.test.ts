import assert from "node:assert/strict"
import test from "node:test"

import { createPostgresAgentDelegationRepository } from "../src/capabilities/agent-delegations/postgres"
import type { AgentDelegation } from "../src/capabilities/agent-delegations/contract"
import type { SqlAdapter, SqlQueryResult, SqlTransaction } from "../src/persistence/sql-adapter"

type Row = Record<string, unknown>

class FakeSql implements SqlAdapter, SqlTransaction {
  readonly calls: Array<{ text: string; parameters: readonly unknown[] }> = []
  transactions = 0

  async query<Result extends Row = Row>(
    text: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlQueryResult<Result>> {
    this.calls.push({ text, parameters })
    if (text.includes("from genio_one_publications")) {
      return { rows: [{ gateway_id: "gateway-ai" }] as unknown as Result[], rowCount: 1 }
    }
    if (text.includes("insert into genio_one_agent_delegation_revisions")) {
      const revision = Number(parameters[2])
      const row = {
        tenant_id: parameters[0],
        delegation_id: parameters[1],
        revision,
        principal_subject_id: parameters[3],
        agent_subject_id: parameters[4],
        resource_id: parameters[5],
        capability_ids: parameters[6],
        acting_client_ids: parameters[7],
        starts_at: parameters[8],
        expires_at: parameters[9],
        revocation_generation: parameters[10],
        state: parameters[11],
        created_by_subject_id: parameters[12],
        created_at: parameters[13],
      }
      return { rows: [row] as unknown as Result[], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  }

  async transaction<Result>(work: (transaction: SqlTransaction) => Promise<Result>): Promise<Result> {
    this.transactions += 1
    return work(this)
  }
}

test("Postgres Agent Delegation appends immutable revisions and reconciles the published Resource atomically", async () => {
  const sql = new FakeSql()
  const releases: Array<{ tenantId: string; gatewayId: string; issuedAt: number }> = []
  const repository = createPostgresAgentDelegationRepository({
    sql,
    releasePublisher: {
      async reconcileInTransaction(input) {
        releases.push({ tenantId: input.tenantId, gatewayId: input.gatewayId, issuedAt: input.issuedAt })
      },
    },
  })
  const active: AgentDelegation = {
    tenant_id: "tenant-acme",
    delegation_id: "delegation-1",
    revision: 1,
    principal_subject_id: "person-principal",
    agent_subject_id: "agent-worker",
    resource_id: "resource-support",
    capability_ids: ["ticket.read"],
    acting_client_ids: ["agent-runtime"],
    starts_at: 1_000,
    expires_at: 2_000,
    revocation_generation: 0,
    state: "ACTIVE",
    created_by_subject_id: "person-principal",
    created_at: 1_000,
  }
  assert.deepEqual(await repository.create(active), active)
  const revoked = await repository.appendRevoked({
    current: active,
    actorSubjectId: "person-principal",
    createdAt: 1_100,
  })
  assert.equal(revoked.revision, 2)
  assert.equal(revoked.revocation_generation, 1)
  assert.equal(revoked.state, "REVOKED")
  assert.equal(sql.transactions, 2)
  assert.deepEqual(releases, [
    { tenantId: "tenant-acme", gatewayId: "gateway-ai", issuedAt: 1_000 },
    { tenantId: "tenant-acme", gatewayId: "gateway-ai", issuedAt: 1_100 },
  ])
  assert.equal(sql.calls.filter(({ text }) => text.includes("for update")).length, 2)
})
