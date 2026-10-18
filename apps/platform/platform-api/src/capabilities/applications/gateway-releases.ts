import type { SqlTransaction } from "../../persistence/sql-adapter"
import type { ResourceLifecycleReleasePublisher } from "../resources/module"
import { PlatformApiError } from "../errors"

export async function reconcileApplicationResourceGateways(input: {
  transaction: SqlTransaction
  releasePublisher: ResourceLifecycleReleasePublisher | undefined
  tenantId: string
  resourceId: string
  issuedAt: number
}): Promise<void> {
  const gateways = await input.transaction.query<{ gateway_id: string }>(
    `select distinct gateway_id from genio_one_publications
      where tenant_id = $1 and resource_id = $2 and publication_state in ('PUBLISHED', 'DEPRECATED')
      order by gateway_id`,
    [input.tenantId, input.resourceId],
  )
  if (gateways.rows.length && !input.releasePublisher) throw new PlatformApiError("APPLICATION_CREDENTIAL_RELEASE_PUBLISHER_UNAVAILABLE", 503)
  for (const { gateway_id: gatewayId } of gateways.rows) {
    if (typeof gatewayId !== "string" || !gatewayId) throw new PlatformApiError("APPLICATION_CREDENTIAL_DATA_INVALID", 500)
    await input.releasePublisher!.reconcileInTransaction({ transaction: input.transaction, tenantId: input.tenantId, gatewayId, issuedAt: input.issuedAt })
  }
}
