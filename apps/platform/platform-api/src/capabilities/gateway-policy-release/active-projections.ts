import { Check } from "typebox/value"

import type { SqlTransaction } from "../../persistence/sql-adapter"
import { PlatformApiError } from "../errors"
import {
  GatewayProjectionSchema,
  type GatewayProjection,
} from "../gateway-projection/contract"
import { lockGatewayPolicyRelease } from "./transaction-lock"

type DatabaseRow = Record<string, unknown>

export interface GatewayActiveProjectionSetSource {
  listActiveForGatewayInTransaction(input: {
    transaction: SqlTransaction
    tenantId: string
    gatewayId: string
    candidate?: GatewayProjection
  }): Promise<GatewayProjection[]>
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
}

function parsePayload(value: unknown): GatewayProjection {
  let payload = value
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload) as unknown
    } catch {
      throw new PlatformApiError("GATEWAY_ACTIVE_PROJECTION_INVALID", 500)
    }
  }
  if (!Check(GatewayProjectionSchema, payload)) {
    throw new PlatformApiError("GATEWAY_ACTIVE_PROJECTION_INVALID", 500)
  }
  return payload as GatewayProjection
}

function assertProjection(
  projection: GatewayProjection,
  tenantId: string,
  gatewayId: string,
): void {
  if (
    projection.operation !== "APPLY" ||
    projection.tenant_id !== tenantId ||
    projection.publication_endpoint.gateway_id !== gatewayId
  ) {
    throw new PlatformApiError("GATEWAY_ACTIVE_PROJECTION_MISMATCH", 409)
  }
}

function sortAndAssertClosedSet(projections: GatewayProjection[]): GatewayProjection[] {
  const publications = new Set<string>()
  const projectionIds = new Set<string>()
  const resourceCapabilities = new Set<string>()
  for (const projection of projections) {
    const resourceCapability = `${projection.resource_id}\u0000${projection.capability_id}`
    if (
      publications.has(projection.publication_id) ||
      projectionIds.has(projection.projection_id) ||
      resourceCapabilities.has(resourceCapability)
    ) {
      throw new PlatformApiError("GATEWAY_ACTIVE_PROJECTION_AMBIGUOUS", 409)
    }
    publications.add(projection.publication_id)
    projectionIds.add(projection.projection_id)
    resourceCapabilities.add(resourceCapability)
  }
  return projections.sort((left, right) => {
    const publicationOrder = compareUtf8(left.publication_id, right.publication_id)
    return publicationOrder !== 0
      ? publicationOrder
      : compareUtf8(left.projection_id, right.projection_id)
  })
}

/**
 * Read the complete Gateway projection set while holding the same advisory
 * lock used by release-head persistence. Resource rows are locked before the
 * publication rows so Resource edits that create a successor use the same
 * ordering. The candidate remains uncommitted at this point, so it is added
 * explicitly after the published rows are locked.
 */
export function createPostgresGatewayActiveProjectionSetSource(): GatewayActiveProjectionSetSource {
  return {
    async listActiveForGatewayInTransaction(input) {
      if (input.candidate) {
        assertProjection(input.candidate, input.tenantId, input.gatewayId)
      }
      await lockGatewayPolicyRelease(input)
      const candidateResourceId = input.candidate?.resource_id ?? null
      const candidateCapabilityId = input.candidate?.capability_id ?? null
      const preliminary = await input.transaction.query<DatabaseRow>(
        `select distinct projection.resource_id
           from genio_one_publications publication
           join genio_one_gateway_projections projection
             on projection.tenant_id = publication.tenant_id
            and projection.publication_id = publication.publication_id
            and projection.endpoint_revision = publication.endpoint_revision
            and projection.resource_revision = publication.resource_revision
          where publication.tenant_id = $1
            and publication.gateway_id = $2
            and publication.publication_state in ('PUBLISHED', 'DEPRECATED')
            and ($3::text is null or projection.resource_id <> $3 or projection.capability_id <> $4)
          order by projection.resource_id`,
        [input.tenantId, input.gatewayId, candidateResourceId, candidateCapabilityId],
      )
      const resourceIds = [...new Set([
        ...preliminary.rows.map((row) => typeof row.resource_id === "string" ? row.resource_id : ""),
        input.candidate?.resource_id ?? "",
      ].filter(Boolean))].sort(compareUtf8)
      if (resourceIds.length) {
        const lockedResources = await input.transaction.query<DatabaseRow>(
          `select resource_id
             from genio_one_resources
            where tenant_id = $1 and resource_id = any($2::text[])
            order by resource_id
            for update`,
          [input.tenantId, resourceIds],
        )
        if (lockedResources.rows.length !== resourceIds.length) {
          throw new PlatformApiError("GATEWAY_ACTIVE_PROJECTION_MISMATCH", 409)
        }
      }
      const result = await input.transaction.query<DatabaseRow>(
        `select projection.payload
           from genio_one_publications publication
           join genio_one_gateway_projections projection
             on projection.tenant_id = publication.tenant_id
            and projection.publication_id = publication.publication_id
            and projection.endpoint_revision = publication.endpoint_revision
            and projection.resource_revision = publication.resource_revision
          where publication.tenant_id = $1
            and publication.gateway_id = $2
            and publication.publication_state in ('PUBLISHED', 'DEPRECATED')
            and ($3::text is null or projection.resource_id <> $3 or projection.capability_id <> $4)
          order by publication.publication_id, projection.projection_id
          for update of publication, projection`,
        [
          input.tenantId,
          input.gatewayId,
          candidateResourceId,
          candidateCapabilityId,
        ],
      )
      const active = result.rows.map((row) => parsePayload(row.payload))
      active.forEach((projection) => assertProjection(
        projection,
        input.tenantId,
        input.gatewayId,
      ))
      const lockedResourceIds = [...new Set([
        ...active.map((projection) => projection.resource_id),
        input.candidate?.resource_id ?? "",
      ].filter(Boolean))].sort(compareUtf8)
      if (
        lockedResourceIds.length !== resourceIds.length ||
        lockedResourceIds.some((resourceId, index) => resourceId !== resourceIds[index])
      ) {
        throw new PlatformApiError("GATEWAY_ACTIVE_PROJECTION_MISMATCH", 409)
      }
      return sortAndAssertClosedSet(
        input.candidate ? [...active, input.candidate] : active,
      )
    },
  }
}
