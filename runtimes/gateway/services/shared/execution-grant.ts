import { createHash } from "node:crypto"

export interface ExecutionGrantConsumer {
  consume(input: { tenant_id: string; execution_grant_id: string; correlation_id: string; expires_at: number; now: number }): Promise<"CONSUMED" | "ALREADY_CONSUMED">
}

export function executionActionDigest(input: { method: string; path: string; body: string }): string {
  return createHash("sha256")
    .update(input.method.toUpperCase())
    .update("\0")
    .update(input.path)
    .update("\0")
    .update(input.body)
    .digest("hex")
}
