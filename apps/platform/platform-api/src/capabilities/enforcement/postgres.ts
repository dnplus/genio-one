import { createHash } from "node:crypto"

import { Check } from "typebox/value"

import { PlatformApiError } from "../errors"
import type { SqlAdapter, SqlTransaction } from "../../persistence/sql-adapter"
import { lockGatewayPolicyRelease } from "../gateway-policy-release/transaction-lock"
import { validateCompiledEnforcementChainSemantics } from "./compiler"
import {
  CompiledEnforcementChainSchema,
  type CompiledEnforcementChain,
  type EnforcementChainRevisionKey,
} from "./contract"
import type {
  EnforcementChainReleasePublisher,
  EnforcementChainRevision,
  EnforcementChainRevisionReader,
} from "./module"

type DatabaseRow = Record<string, unknown>

export interface PostgresEnforcementChainRevisionOptions {
  sql: SqlAdapter
  now?: () => number
  releasePublisher?: EnforcementChainReleasePublisher
}

export interface PostgresEnforcementChainRevisionStore
  extends EnforcementChainRevisionReader {}

const CHAIN_COLUMNS = `
  tenant_id,
  resource_id,
  capability_id,
  one_policy_revision,
  chain,
  chain_digest,
  created_at,
  updated_at`

function assertTenantId(tenantId: string): void {
  if (!tenantId.trim()) {
    throw new PlatformApiError("TENANT_REQUIRED", 422, "A tenant id is required")
  }
}

function assertIdentifier(value: string, code: string): void {
  if (!value.trim()) throw new PlatformApiError(code, 422)
}

function assertPolicyRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new PlatformApiError(
      "ENFORCEMENT_POLICY_REVISION_INVALID",
      422,
      "One Policy revision must be a positive integer",
    )
  }
}

function rowString(row: DatabaseRow, key: string): string {
  const value = row[key]
  if (typeof value !== "string" || !value.trim()) {
    throw new PlatformApiError(
      "ENFORCEMENT_CHAIN_DATA_INVALID",
      500,
      `Persisted enforcement chain ${key} is invalid`,
    )
  }
  return value
}

function rowRevision(row: DatabaseRow): number {
  const value = row.one_policy_revision
  const revision =
    typeof value === "bigint"
      ? Number(value)
      : typeof value === "number"
        ? value
        : typeof value === "string"
          ? Number(value)
          : Number.NaN
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new PlatformApiError(
      "ENFORCEMENT_CHAIN_DATA_INVALID",
      500,
      "Persisted enforcement chain policy revision is invalid",
    )
  }
  return revision
}

function rowTimestamp(row: DatabaseRow, key: string, fallback: number): number {
  const value = row[key]
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value)
  if (typeof value === "bigint") return Number(value)
  if (typeof value === "string") {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return Math.floor(numeric)
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000)
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return Math.floor(value.getTime() / 1000)
  }
  return fallback
}

/**
 * JSON object keys are sorted recursively while arrays retain their order.
 * Candidate ordering can be meaningful to a routing policy, so it must not
 * be erased while making object construction order irrelevant to the digest.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item))
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    )
  }
  return value
}

function canonicalEnforcementChainJson(
  chain: CompiledEnforcementChain,
): string {
  return JSON.stringify(canonicalize(chain))
}

export function canonicalEnforcementChainDigest(
  chain: CompiledEnforcementChain,
): string {
  return createHash("sha256")
    .update(canonicalEnforcementChainJson(chain))
    .digest("hex")
}

function parseChain(value: unknown): CompiledEnforcementChain {
  let parsed = value
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown
    } catch {
      throw new PlatformApiError(
        "ENFORCEMENT_CHAIN_DATA_INVALID",
        500,
        "Persisted enforcement chain JSON is invalid",
      )
    }
  }
  if (!Check(CompiledEnforcementChainSchema, parsed)) {
    throw new PlatformApiError(
      "ENFORCEMENT_CHAIN_DATA_INVALID",
      500,
      "Persisted enforcement chain does not match the canonical contract",
    )
  }
  try {
    validateCompiledEnforcementChainSemantics(parsed as CompiledEnforcementChain)
  } catch {
    throw new PlatformApiError(
      "ENFORCEMENT_CHAIN_DATA_INVALID",
      500,
      "Persisted enforcement chain violates the execution invariants",
    )
  }
  return parsed as CompiledEnforcementChain
}

function assertChainIdentity(
  chain: CompiledEnforcementChain,
  key: EnforcementChainRevisionKey,
): void {
  if (
    chain.tenant_id !== key.tenantId ||
    chain.resource_id !== key.resourceId ||
    chain.capability_id !== key.capabilityId ||
    chain.one_policy_revision !== key.onePolicyRevision
  ) {
    throw new PlatformApiError(
      "ENFORCEMENT_CHAIN_SCOPE_MISMATCH",
      422,
      "Enforcement chain identity does not match its tenant-scoped revision key",
    )
  }
}

function mapRevision(
  row: DatabaseRow,
  now: () => number,
  expected?: EnforcementChainRevisionKey,
): EnforcementChainRevision {
  const tenantId = rowString(row, "tenant_id")
  const resourceId = rowString(row, "resource_id")
  const capabilityId = rowString(row, "capability_id")
  const onePolicyRevision = rowRevision(row)
  const chain = parseChain(row.chain)
  const key = {
    tenantId,
    resourceId,
    capabilityId,
    onePolicyRevision,
  }
  assertChainIdentity(chain, key)
  if (
    expected &&
    (expected.tenantId !== tenantId ||
      expected.resourceId !== resourceId ||
      expected.capabilityId !== capabilityId ||
      expected.onePolicyRevision !== onePolicyRevision)
  ) {
    throw new PlatformApiError(
      "ENFORCEMENT_CHAIN_SCOPE_MISMATCH",
      500,
      "Persisted enforcement chain row is outside the requested tenant scope",
    )
  }
  const digest = rowString(row, "chain_digest")
  if (digest !== canonicalEnforcementChainDigest(chain)) {
    throw new PlatformApiError(
      "ENFORCEMENT_CHAIN_DIGEST_INVALID",
      500,
      "Persisted enforcement chain digest does not match its canonical content",
    )
  }
  return {
    tenant_id: tenantId,
    resource_id: resourceId,
    capability_id: capabilityId,
    one_policy_revision: onePolicyRevision,
    chain,
    chain_digest: digest,
    created_at: rowTimestamp(row, "created_at", now()),
    updated_at: rowTimestamp(row, "updated_at", now()),
  }
}

function keyValues(key: EnforcementChainRevisionKey): readonly unknown[] {
  return [
    key.tenantId,
    key.resourceId,
    key.capabilityId,
    key.onePolicyRevision,
  ]
}

async function selectRevision(
  executor: SqlAdapter | SqlTransaction,
  key: EnforcementChainRevisionKey,
  forUpdate = false,
): Promise<DatabaseRow | null> {
  const result = await executor.query<DatabaseRow>(
    `select ${CHAIN_COLUMNS}
       from genio_one_enforcement_chain_revisions
      where tenant_id = $1
        and resource_id = $2
        and capability_id = $3
        and one_policy_revision = $4${forUpdate ? " for update" : ""}`,
    keyValues(key),
  )
  return result.rows[0] ?? null
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  )
}

function keyForChain(chain: CompiledEnforcementChain): EnforcementChainRevisionKey {
  return {
    tenantId: chain.tenant_id,
    resourceId: chain.resource_id,
    capabilityId: chain.capability_id,
    onePolicyRevision: chain.one_policy_revision,
  }
}

function validateSaveInput(
  tenantId: string,
  chain: CompiledEnforcementChain,
): EnforcementChainRevisionKey {
  assertTenantId(tenantId)
  const key = keyForChain(chain)
  assertIdentifier(key.resourceId, "RESOURCE_REQUIRED")
  assertIdentifier(key.capabilityId, "CAPABILITY_REQUIRED")
  assertPolicyRevision(key.onePolicyRevision)
  assertChainIdentity(chain, { ...key, tenantId })
  if (
    !Array.isArray(chain.eligible_connection_ids) ||
    chain.eligible_connection_ids.length === 0
  ) {
    throw new PlatformApiError("ENFORCEMENT_CONNECTION_CANDIDATES_REQUIRED", 422)
  }
  if (
    new Set(chain.eligible_connection_ids).size !==
    chain.eligible_connection_ids.length
  ) {
    throw new PlatformApiError("DUPLICATE_ENFORCEMENT_CONNECTION_CANDIDATE", 422)
  }
  validateCompiledEnforcementChainSemantics(chain)
  return { ...key, tenantId }
}

type PublishedGateway = {
  gatewayId: string
}

/**
 * A chain insert holds a PostgreSQL key-share lock on its Resource through
 * the revision table's foreign key.  Resolve an active Gateway before that
 * insert so a release always takes Gateway before Resource, rather than
 * waiting for the Gateway while the foreign-key lock is held.
 */
async function activeGatewayForResource(
  executor: SqlAdapter | SqlTransaction,
  key: Pick<EnforcementChainRevisionKey, "tenantId" | "resourceId">,
): Promise<PublishedGateway | null> {
  const publication = await executor.query<DatabaseRow>(
    `select gateway_id, publication_state
       from genio_one_publications
      where tenant_id = $1 and resource_id = $2
      order by endpoint_revision desc
      limit 1`,
    [key.tenantId, key.resourceId],
  )
  const gatewayId = publication.rows[0]?.gateway_id
  const publicationState = publication.rows[0]?.publication_state
  if (
    typeof gatewayId !== "string" || !gatewayId.trim() ||
    (publicationState !== "PUBLISHED" && publicationState !== "DEPRECATED")
  ) {
    return null
  }
  return { gatewayId }
}

/** PostgreSQL store for immutable, tenant-scoped compiled chain revisions. */
export function createPostgresEnforcementChainRevisionStore(
  options: PostgresEnforcementChainRevisionOptions,
): PostgresEnforcementChainRevisionStore {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))

  return {
    async listInventory({ tenantId }) {
      assertTenantId(tenantId)
      const result = await options.sql.query<DatabaseRow>(
        `select distinct on (resource_id, capability_id) ${CHAIN_COLUMNS}
           from genio_one_enforcement_chain_revisions
          where tenant_id = $1
          order by resource_id, capability_id, one_policy_revision desc`,
        [tenantId],
      )
      return result.rows.map((row) => {
        const resourceId = rowString(row, "resource_id")
        const capabilityId = rowString(row, "capability_id")
        const onePolicyRevision = rowRevision(row)
        try {
          const revision = mapRevision(row, now)
          return {
            tenant_id: tenantId,
            resource_id: resourceId,
            capability_id: capabilityId,
            one_policy_revision: onePolicyRevision,
            status: "READY" as const,
            revision,
            issue_code: null,
          }
        } catch (error) {
          if (!(error instanceof PlatformApiError)) throw error
          return {
            tenant_id: tenantId,
            resource_id: resourceId,
            capability_id: capabilityId,
            one_policy_revision: onePolicyRevision,
            status: "MIGRATION_REQUIRED" as const,
            revision: null,
            issue_code: error.code,
          }
        }
      })
    },
    async getLatest(input) {
      assertTenantId(input.tenantId)
      assertIdentifier(input.resourceId, "RESOURCE_REQUIRED")
      assertIdentifier(input.capabilityId, "CAPABILITY_REQUIRED")
      const result = await options.sql.query<DatabaseRow>(
        `select ${CHAIN_COLUMNS}
           from genio_one_enforcement_chain_revisions
          where tenant_id = $1 and resource_id = $2 and capability_id = $3
          order by one_policy_revision desc
          limit 1`,
        [input.tenantId, input.resourceId, input.capabilityId],
      )
      const row = result.rows[0]
      return row ? mapRevision(row, now) : null
    },
    async get(input) {
      assertTenantId(input.tenantId)
      assertIdentifier(input.resourceId, "RESOURCE_REQUIRED")
      assertIdentifier(input.capabilityId, "CAPABILITY_REQUIRED")
      assertPolicyRevision(input.onePolicyRevision)
      const row = await selectRevision(options.sql, input)
      return row ? mapRevision(row, now, input) : null
    },

    async save({ tenantId, chain }) {
      const key = validateSaveInput(tenantId, chain)
      const digest = canonicalEnforcementChainDigest(chain)
      const chainJson = canonicalEnforcementChainJson(chain)

      return options.sql.transaction(async (transaction) => {
        const gatewayBeforeWrite = await activeGatewayForResource(transaction, key)
        if (gatewayBeforeWrite) {
          await lockGatewayPolicyRelease({
            transaction,
            tenantId: key.tenantId,
            gatewayId: gatewayBeforeWrite.gatewayId,
          })
        }
        let inserted: DatabaseRow | null = null
        try {
          const result = await transaction.query<DatabaseRow>(
            `insert into genio_one_enforcement_chain_revisions
               (tenant_id, resource_id, capability_id, one_policy_revision,
                eligible_connection_ids, chain, chain_digest)
             values ($1, $2, $3, $4, $5::text::jsonb, $6::text::jsonb, $7)
             on conflict (tenant_id, resource_id, capability_id, one_policy_revision)
             do nothing
             returning ${CHAIN_COLUMNS}`,
            [
              key.tenantId,
              key.resourceId,
              key.capabilityId,
              key.onePolicyRevision,
              JSON.stringify(chain.eligible_connection_ids),
              chainJson,
              digest,
            ],
          )
          inserted = result.rows[0] ?? null
        } catch (error) {
          // A concurrent transaction may win the immutable identity.  Read
          // it below and apply the same digest/idempotency rule rather than
          // leaking a driver-specific unique-violation error.
          if (!isUniqueViolation(error)) throw error
        }

        if (inserted) {
          const revision = mapRevision(inserted, now, key)
          const gatewayAfterWrite = await activeGatewayForResource(transaction, key)
          if (
            gatewayAfterWrite &&
            gatewayAfterWrite.gatewayId !== gatewayBeforeWrite?.gatewayId
          ) {
            // Do not acquire a newly discovered Gateway after the insert has
            // acquired its Resource foreign-key lock.  Roll back and let the
            // caller retry against one coherent publication identity.
            throw new PlatformApiError(
              "ENFORCEMENT_CHAIN_PUBLICATION_CHANGED",
              409,
              "The active publication changed while saving an enforcement chain; retry the request",
            )
          }
          if (gatewayAfterWrite) {
            if (!options.releasePublisher) {
              throw new PlatformApiError("GATEWAY_RELEASE_PUBLISHER_REQUIRED", 500)
            }
            await options.releasePublisher.reconcileInTransaction({
              transaction,
              tenantId: key.tenantId,
              gatewayId: gatewayAfterWrite.gatewayId,
              issuedAt: now(),
            })
          }
          return revision
        }

        const existing = await selectRevision(transaction, key, true)
        if (!existing) {
          throw new PlatformApiError(
            "ENFORCEMENT_CHAIN_REVISION_WRITE_RACE",
            500,
            "Enforcement chain revision disappeared during an immutable save",
          )
        }
        const mapped = mapRevision(existing, now, key)
        if (mapped.chain_digest === digest) return mapped
        throw new PlatformApiError(
          "ENFORCEMENT_CHAIN_REVISION_IMMUTABLE",
          409,
          "An enforcement chain revision cannot be overwritten with different content",
        )
      })
    },
  }
}
