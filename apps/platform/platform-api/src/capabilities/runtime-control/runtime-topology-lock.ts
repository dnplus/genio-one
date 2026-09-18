import type { SqlTransaction } from "../../persistence/sql-adapter"

const Identifier = /^(?!\s)(?!.*\s$)[^\u0000\r\n]{1,256}$/u

/**
 * Serialize runtime registration, capability changes, and target selection for
 * one tenant. A row lock cannot prevent a newly inserted eligible runtime from
 * appearing after an exact-one selector has already read its candidate set.
 */
export async function lockRuntimeTopology(input: {
  transaction: SqlTransaction
  tenantId: string
}): Promise<void> {
  if (!Identifier.test(input.tenantId)) throw new Error("tenantId must be a non-empty identifier")
  await input.transaction.query(
    "select pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`tenant:${input.tenantId}|runtime-topology`],
  )
}
