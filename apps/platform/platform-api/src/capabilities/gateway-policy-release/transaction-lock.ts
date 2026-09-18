import type { SqlTransaction } from "../../persistence/sql-adapter"

const Identifier = /^(?!\s)(?!.*\s$)[^\u0000\r\n]{1,256}$/u

function assertIdentifier(value: string, label: string): void {
  if (!Identifier.test(value)) {
    throw new Error(`${label} must be a non-empty identifier`)
  }
}

/**
 * Serialize every aggregate release transition for one tenant/Gateway. The
 * active projection read, release head CAS, and durable command enqueue must
 * all run while this transaction-scoped lock is held.
 */
export async function lockGatewayPolicyRelease(input: {
  transaction: SqlTransaction
  tenantId: string
  gatewayId: string
}): Promise<void> {
  assertIdentifier(input.tenantId, "tenantId")
  assertIdentifier(input.gatewayId, "gatewayId")
  await input.transaction.query(
    "select pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`tenant:${input.tenantId}|gateway:${input.gatewayId}`],
  )
}
