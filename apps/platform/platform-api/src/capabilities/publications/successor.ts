import type { SqlTransaction } from "../../persistence/sql-adapter"
import { PlatformApiError } from "../errors"

type DatabaseRow = Record<string, unknown>

function text(row: DatabaseRow, key: string): string {
  const value = row[key]
  if (typeof value !== "string" || !value.trim()) {
    throw new PlatformApiError("PUBLICATION_DATA_INVALID", 500)
  }
  return value
}

function integer(row: DatabaseRow, key: string): number {
  const value = row[key]
  const parsed = typeof value === "bigint" ? Number(value) : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new PlatformApiError("PUBLICATION_DATA_INVALID", 500)
  }
  return parsed
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown
    } catch {
      throw new PlatformApiError("PUBLICATION_DATA_INVALID", 500)
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PlatformApiError("PUBLICATION_DATA_INVALID", 500)
  }
  return value as Record<string, unknown>
}

export interface PublicationSuccessorReference {
  publicationId: string
  endpointRevision: number
  resourceRevision: number
  resourceDigest: string
  gatewayId: string
}

export async function ensurePublicationSuccessorInTransaction(input: {
  transaction: SqlTransaction
  tenantId: string
  resourceId: string
  idFactory: (prefix: string) => string
}): Promise<PublicationSuccessorReference | null> {
  const resourceResult = await input.transaction.query<DatabaseRow>(
    `select lifecycle, row_revision
       from genio_one_resources
      where tenant_id = $1 and resource_id = $2
      for update`,
    [input.tenantId, input.resourceId],
  )
  const resource = resourceResult.rows[0]
  if (!resource || (resource.lifecycle !== "DRAFT" && resource.lifecycle !== "PUBLISHED")) return null
  const publicationResult = await input.transaction.query<DatabaseRow>(
    `select publication_id, endpoint_revision, resource_revision, resource_digest,
            gateway_id, hostname, base_path, visibility, publication_state,
            publication_build_state, dns_management, dns_proof_status, dns_proof
       from genio_one_publications
      where tenant_id = $1 and resource_id = $2
      order by endpoint_revision desc
      limit 1
      for update`,
    [input.tenantId, input.resourceId],
  )
  const current = publicationResult.rows[0]
  if (!current) {
    if (resource.lifecycle !== "PUBLISHED") return null
    throw new PlatformApiError("RESOURCE_PUBLICATION_REQUIRED", 409)
  }
  const state = text(current, "publication_state")
  if (state !== "PUBLISHED") {
    if (state === "DRAFT") {
      const resourceRevision = integer(resource, "row_revision")
      const updated = await input.transaction.query(
        `update genio_one_publications
            set resource_revision = $3,
                row_revision = row_revision + 1,
                updated_at = now()
          where tenant_id = $1 and publication_id = $2
            and publication_state = 'DRAFT'
            and publication_build_state = 'IDLE'
            and request_snapshot = '{}'::jsonb
            and publication_snapshot = '{}'::jsonb`,
        [input.tenantId, text(current, "publication_id"), resourceRevision],
      )
      if (updated.rowCount === 1) {
        return {
          publicationId: text(current, "publication_id"),
          endpointRevision: integer(current, "endpoint_revision"),
          resourceRevision,
          resourceDigest: text(current, "resource_digest"),
          gatewayId: text(current, "gateway_id"),
        }
      }
    }
    const failedBuild = state === "PENDING_REVIEW" && text(current, "publication_build_state") === "FAILED"
    if (failedBuild) {
      return createSuccessor(input, current, resource)
    }
    if (!["DRAFT", "PENDING_REVIEW"].includes(state)) {
      throw new PlatformApiError("PUBLICATION_SUCCESSOR_CONFLICT", 409)
    }
    return {
      publicationId: text(current, "publication_id"),
      endpointRevision: integer(current, "endpoint_revision"),
      resourceRevision: integer(current, "resource_revision"),
      resourceDigest: text(current, "resource_digest"),
      gatewayId: text(current, "gateway_id"),
    }
  }
  return createSuccessor(input, current, resource)
}

async function createSuccessor(
  input: {
    transaction: SqlTransaction
    tenantId: string
    resourceId: string
    idFactory: (prefix: string) => string
  },
  current: DatabaseRow,
  resource: DatabaseRow,
): Promise<PublicationSuccessorReference> {
  const publicationId = input.idFactory("publication")
  const endpointRevision = integer(current, "endpoint_revision") + 1
  const resourceRevision = integer(resource, "row_revision")
  const resourceDigest = text(current, "resource_digest")
  const gatewayId = text(current, "gateway_id")
  await input.transaction.query(
    `insert into genio_one_publications
      (tenant_id, publication_id, resource_id, endpoint_revision,
       resource_revision, resource_digest, policy_revision, gateway_id,
       hostname, base_path, visibility, publication_state, dns_management,
       dns_proof_status, dns_proof, request_snapshot, review_snapshot)
     values ($1, $2, $3, $4, $5, $6, 0, $7, $8, $9, $10, 'DRAFT',
             $11, $12, $13::text::jsonb, '{}'::jsonb, '{}'::jsonb)`,
    [
      input.tenantId,
      publicationId,
      input.resourceId,
      endpointRevision,
      resourceRevision,
      resourceDigest,
      gatewayId,
      text(current, "hostname"),
      text(current, "base_path"),
      text(current, "visibility"),
      text(current, "dns_management"),
      text(current, "dns_proof_status"),
      JSON.stringify(object(current.dns_proof)),
    ],
  )
  return { publicationId, endpointRevision, resourceRevision, resourceDigest, gatewayId }
}
