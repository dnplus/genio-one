
import { Check } from "typebox/value"

import { PlatformApiError } from "../errors"
import type { SqlAdapter, SqlTransaction } from "../../persistence/sql-adapter"
import { lockGatewayPolicyRelease } from "../gateway-policy-release/transaction-lock"
import { canonicalJson } from "@genioone/protocol/canonical"
import { canonicalEnforcementChainDigest, compileValidatedEnforcementChain, validateCompiledEnforcementChainSemantics } from "./compiler"
import {
  CompiledEnforcementChainSchema,
  type CompileEnforcementChainInput,
  type CompiledEnforcementChain,
  type EnforcementChainRevisionKey,
} from "./contract"
import { connectionCertificateFromStored } from "../connections/certificate"
import { isEnforcementConnectionReady } from "./connection-eligibility"
import { policyDraftFromStoredValue, requireResourcePolicyDraft, resourcePolicyKey } from "../one-policy/drafts"
import { policyChangeAuditEvent, policySystemPublishAuditEvent } from "../one-policy/lifecycle"
import type { GatewayAuthorizationAuditStore } from "../audit-events/module"
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
  audit?: GatewayAuthorizationAuditStore
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
  published_by_subject_id,
  reviewed_by_subject_id,
  rollback_source_one_policy_revision,
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

function nullableString(row: DatabaseRow, key: string): string | null {
  const value = row[key]
  if (value === null || value === undefined) return null
  if (typeof value !== "string" || !value.trim()) {
    throw new PlatformApiError("ENFORCEMENT_CHAIN_DATA_INVALID", 500)
  }
  return value
}

function nullableRevision(row: DatabaseRow, key: string): number | null {
  const value = row[key]
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new PlatformApiError("ENFORCEMENT_CHAIN_DATA_INVALID", 500)
  }
  return parsed
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
    published_by_subject_id: nullableString(row, "published_by_subject_id"),
    reviewed_by_subject_id: nullableString(row, "reviewed_by_subject_id"),
    rollback_source_one_policy_revision: nullableRevision(row, "rollback_source_one_policy_revision"),
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

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new PlatformApiError("ENFORCEMENT_CHAIN_DATA_INVALID", 500)
  }
}

function resourceOwnsCapability(value: unknown, capabilityId: string): boolean {
  const capabilities = jsonValue(value)
  return Array.isArray(capabilities) && capabilities.some((candidate) =>
    typeof candidate === "object" &&
    candidate !== null &&
    "capability_id" in candidate &&
    candidate.capability_id === capabilityId)
}

function connectionReadyForChain(row: DatabaseRow, now: () => number): boolean {
  const certificate = connectionCertificateFromStored({
    mode: row.certificate_mode ?? "SYSTEM_CA",
    certificate_pem: row.certificate_pem,
    fingerprint_sha256: row.certificate_fingerprint_sha256,
    subject: row.certificate_subject,
    issuer: row.certificate_issuer,
    is_self_signed: row.certificate_is_self_signed,
    not_before: row.certificate_not_before,
    not_after: row.certificate_not_after,
  }, now())
  return isEnforcementConnectionReady({
    status: rowString(row, "status"),
    lifecycle: rowString(row, "lifecycle"),
    verification_state: rowString(row, "verification_state"),
    health_state: rowString(row, "health_state"),
    certificate,
  })
}

const CONNECTION_SCOPE_COLUMNS = `connection_id, resource_id, status, lifecycle,
  verification_state, health_state, certificate_mode, certificate_pem,
  certificate_fingerprint_sha256, certificate_subject, certificate_issuer,
  certificate_is_self_signed, certificate_not_before, certificate_not_after`

async function compileResourceDraftInTransaction(
  transaction: SqlTransaction,
  input: {
    tenantId: string
    resourceId: string
    capabilityId: string
    definition: Omit<CompileEnforcementChainInput, "resource_id" | "capability_id" | "eligible_connection_ids">
      & { eligible_connection_ids?: string[] }
  },
  now: () => number,
): Promise<CompiledEnforcementChain> {
  const resource = await transaction.query<DatabaseRow>(
    `select capabilities
       from genio_one_resources
      where tenant_id = $1 and resource_id = $2
      for update`,
    [input.tenantId, input.resourceId],
  )
  if (!resource.rows[0] || !resourceOwnsCapability(resource.rows[0].capabilities, input.capabilityId)) {
    throw new PlatformApiError("ENFORCEMENT_CAPABILITY_NOT_FOUND", 422)
  }
  const requested = input.definition.eligible_connection_ids
  if (requested && new Set(requested).size !== requested.length) {
    throw new PlatformApiError("DUPLICATE_ENFORCEMENT_CONNECTION_CANDIDATE", 422)
  }
  const result = await transaction.query<DatabaseRow>(
    `select ${CONNECTION_SCOPE_COLUMNS}
       from genio_one_resource_connections
      where tenant_id = $1 and resource_id = $2
        and ($3::text[] is null or connection_id = any($3::text[]))
      order by connection_id
      for update`,
    [input.tenantId, input.resourceId, requested ?? null],
  )
  const rows = result.rows
  if (requested && rows.length !== requested.length) {
    throw new PlatformApiError("ENFORCEMENT_CONNECTION_MISMATCH", 422)
  }
  const eligibleConnectionIds = rows
    .filter((row) => connectionReadyForChain(row, now))
    .map((row) => rowString(row, "connection_id"))
    .sort()
  if (requested && eligibleConnectionIds.length !== requested.length) {
    throw new PlatformApiError("ENFORCEMENT_CONNECTION_NOT_READY", 409)
  }
  if (eligibleConnectionIds.length === 0) {
    throw new PlatformApiError("ENFORCEMENT_CONNECTION_CANDIDATES_REQUIRED", 422)
  }
  return compileValidatedEnforcementChain({
    tenantId: input.tenantId,
    value: {
      ...input.definition,
      resource_id: input.resourceId,
      capability_id: input.capabilityId,
      eligible_connection_ids: requested ?? eligibleConnectionIds,
    },
  })
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

  async function lockPolicy(transaction: SqlTransaction, tenantId: string, resourceId: string, capabilityId: string): Promise<void> {
    await transaction.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify(["resource-policy", tenantId, resourceId, capabilityId])])
  }

  async function saveInTransaction(
    transaction: SqlTransaction,
    tenantId: string,
    chain: CompiledEnforcementChain,
    lockedGateway?: PublishedGateway | null,
    provenance: { publishedBySubjectId: string | null; reviewedBySubjectId: string | null; rollbackSourceOnePolicyRevision: number | null } = {
      publishedBySubjectId: "system",
      reviewedBySubjectId: null,
      rollbackSourceOnePolicyRevision: null,
    },
  ): Promise<{ revision: EnforcementChainRevision; created: boolean }> {
    const key = validateSaveInput(tenantId, chain)
    const digest = canonicalEnforcementChainDigest(chain)
    const chainJson = canonicalJson(chain)
    const gatewayBeforeWrite = lockedGateway === undefined
      ? await activeGatewayForResource(transaction, key)
      : lockedGateway
    if (lockedGateway === undefined && gatewayBeforeWrite) {
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
            eligible_connection_ids, chain, chain_digest,
            published_by_subject_id, reviewed_by_subject_id,
            rollback_source_one_policy_revision)
         values ($1, $2, $3, $4, $5::text::jsonb, $6::text::jsonb, $7, $8, $9, $10)
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
          provenance.publishedBySubjectId,
          provenance.reviewedBySubjectId,
          provenance.rollbackSourceOnePolicyRevision,
        ],
      )
      inserted = result.rows[0] ?? null
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
    }
    if (inserted) {
      const revision = mapRevision(inserted, now, key)
      const gatewayAfterWrite = await activeGatewayForResource(transaction, key)
      if (gatewayAfterWrite && gatewayAfterWrite.gatewayId !== gatewayBeforeWrite?.gatewayId) {
        throw new PlatformApiError("ENFORCEMENT_CHAIN_PUBLICATION_CHANGED", 409)
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
      return { revision, created: true }
    }
    const existing = await selectRevision(transaction, key, true)
    if (!existing) {
      throw new PlatformApiError("ENFORCEMENT_CHAIN_REVISION_WRITE_RACE", 500)
    }
    const mapped = mapRevision(existing, now, key)
    if (mapped.chain_digest === digest) return { revision: mapped, created: false }
    throw new PlatformApiError("ENFORCEMENT_CHAIN_REVISION_IMMUTABLE", 409)
  }

  async function latestPolicyRevisionInTransaction(
    transaction: SqlTransaction,
    tenantId: string,
    resourceId: string,
    capabilityId: string,
  ): Promise<number> {
    const result = await transaction.query<DatabaseRow>(
      `select one_policy_revision
         from genio_one_enforcement_chain_revisions
        where tenant_id = $1 and resource_id = $2 and capability_id = $3
        order by one_policy_revision desc
        limit 1
        for update`,
      [tenantId, resourceId, capabilityId],
    )
    return result.rows[0] ? rowRevision(result.rows[0]) : 0
  }

  async function recordPublishedDraft(
    transaction: SqlTransaction,
    input: {
      tenantId: string
      policyKey: string
      draft: NonNullable<ReturnType<typeof policyDraftFromStoredValue>>
      publishedBySubjectId: string
      correlationId: string
      publishedRevision: number
    },
  ): Promise<void> {
    if (!options.audit) return
    if (!options.audit.recordInTransaction) {
      throw new PlatformApiError("POLICY_AUDIT_TRANSACTION_UNAVAILABLE", 500)
    }
    await options.audit.recordInTransaction({
      transaction,
      tenantId: input.tenantId,
      event: policyChangeAuditEvent({
        tenantId: input.tenantId,
        policyKey: input.policyKey,
        draft: input.draft,
        action: "PUBLISHED",
        actorSubjectId: input.publishedBySubjectId,
        correlationId: input.correlationId,
        occurredAt: now(),
        publishedRevision: input.publishedRevision,
      }),
    })
  }

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

    async save({ tenantId, chain, provenance }) {
      validateSaveInput(tenantId, chain)
      const effectiveProvenance = provenance ?? {
        publishedBySubjectId: "system",
        reviewedBySubjectId: null,
        rollbackSourceOnePolicyRevision: null,
      }
      return options.sql.transaction(async (transaction) => {
        await lockPolicy(transaction, tenantId, chain.resource_id, chain.capability_id)
        const { revision: published, created } = await saveInTransaction(transaction, tenantId, chain, undefined, effectiveProvenance)
        if (options.audit && created) {
          if (!options.audit.recordInTransaction) throw new PlatformApiError("POLICY_AUDIT_TRANSACTION_UNAVAILABLE", 500)
          await options.audit.recordInTransaction({
            transaction,
            tenantId,
            event: policySystemPublishAuditEvent({
              tenantId,
              policyKey: resourcePolicyKey(chain.resource_id, chain.capability_id),
              publishedRevision: published.one_policy_revision,
              content: chain,
              actorSubjectId: effectiveProvenance.publishedBySubjectId ?? "system",
              correlationId: effectiveProvenance.correlationId ?? `policy-system-${chain.resource_id}-${chain.capability_id}-${chain.one_policy_revision}`,
              occurredAt: now(),
            }),
          })
        }
        return published
      })
    },
    async publishDraft({ tenantId, resourceId, capabilityId, expectedVersion, expectedContentDigest, publishedBySubjectId, correlationId }) {
      return options.sql.transaction(async (transaction) => {
        await transaction.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify(["policy-draft", tenantId, resourcePolicyKey(resourceId, capabilityId)])])
        const draftResult = await transaction.query<{ value: unknown }>(
          "select value from genio_one_policy_drafts where tenant_id = $1 and policy_key = $2 for update",
          [tenantId, resourcePolicyKey(resourceId, capabilityId)],
        )
        const draft = policyDraftFromStoredValue(draftResult.rows[0]?.value ?? null)
        if (!draft) throw new PlatformApiError("POLICY_DRAFT_CONFLICT", 409)
        const { baseRevision, definition } = requireResourcePolicyDraft(
          draft,
          expectedVersion,
          expectedContentDigest,
        )
        if (definition.one_policy_revision !== baseRevision + 1) {
          throw new PlatformApiError("POLICY_REVISION_CONFLICT", 409)
        }
        await lockPolicy(transaction, tenantId, resourceId, capabilityId)
        const currentRevision = await latestPolicyRevisionInTransaction(
          transaction,
          tenantId,
          resourceId,
          capabilityId,
        )
        if (currentRevision !== baseRevision) {
          throw new PlatformApiError("POLICY_REVISION_CONFLICT", 409)
        }
        const gateway = await activeGatewayForResource(transaction, {
          tenantId,
          resourceId,
        })
        if (gateway) {
          await lockGatewayPolicyRelease({
            transaction,
            tenantId,
            gatewayId: gateway.gatewayId,
          })
        }
        const chain = await compileResourceDraftInTransaction(transaction, {
          tenantId,
          resourceId,
          capabilityId,
          definition,
        }, now)
        const { revision: published } = await saveInTransaction(transaction, tenantId, chain, gateway, {
          publishedBySubjectId,
          reviewedBySubjectId: draft.review?.actor_subject_id ?? null,
          rollbackSourceOnePolicyRevision: null,
        })
        await recordPublishedDraft(transaction, {
          tenantId,
          policyKey: resourcePolicyKey(resourceId, capabilityId),
          draft,
          publishedBySubjectId,
          correlationId,
          publishedRevision: published.one_policy_revision,
        })
        const removed = await transaction.query(
          `update genio_one_policy_drafts
              set value = 'null'::jsonb
            where tenant_id = $1
              and policy_key = $2
              and (value->>'version')::int = $3
              and value->>'content_digest' = $4
              and value->>'lifecycle' = 'REVIEWED'
          returning policy_key`,
          [tenantId, resourcePolicyKey(resourceId, capabilityId), expectedVersion, expectedContentDigest],
        )
        if (removed.rowCount !== 1) throw new PlatformApiError("POLICY_DRAFT_CONFLICT", 409)
        return published
      })
    },
  }
}
