import type { SqlTransaction } from "../../persistence/sql-adapter"
import type { GatewayProjection } from "../gateway-projection/contract"
import type {
  GatewayPublicationReleaseCommitInput,
  GatewayPublicationReleaseCoordinator,
} from "./publication-commit"

export interface GatewayPublicationDeliveryInput {
  transaction: SqlTransaction
  tenantId: string
  gatewayId: string
  projection: GatewayProjection
  issuedAt: number
}

/** One transaction-scoped publication delivery lane. */
export interface GatewayPublicationDelivery {
  deliverInTransaction(input: GatewayPublicationDeliveryInput): Promise<void>
}

export function createAggregateGatewayPublicationDelivery(
  coordinator: GatewayPublicationReleaseCoordinator,
): GatewayPublicationDelivery {
  return {
    async deliverInTransaction(input) {
      const aggregateInput: GatewayPublicationReleaseCommitInput = {
        transaction: input.transaction,
        tenantId: input.tenantId,
        gatewayId: input.gatewayId,
        candidate: input.projection,
        issuedAt: input.issuedAt,
      }
      await coordinator.commitInTransaction(aggregateInput)
    },
  }
}

export function createAggregateGatewayLifecycleReleasePublisher(
  coordinator: GatewayPublicationReleaseCoordinator,
) {
  return {
    async reconcileInTransaction(input: {
      transaction: SqlTransaction
      tenantId: string
      gatewayId: string
      issuedAt: number
    }) {
      await coordinator.reconcileInTransaction(input)
    },
  }
}
