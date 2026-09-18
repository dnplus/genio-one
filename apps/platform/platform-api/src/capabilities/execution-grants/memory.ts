import { PlatformApiError } from "../errors"
import type { ExecutionGrantRepository } from "./module"

export function createInMemoryExecutionGrantRepository(): ExecutionGrantRepository {
  const requests = new Map<string, import("./contract").ExecutionGrantRequest[]>()
  return {
    async createRequest(value) {
      const key = `${value.tenant_id}\0${value.request_id}`
      if (requests.has(key)) throw new PlatformApiError("EXECUTION_GRANT_REQUEST_EXISTS", 409)
      requests.set(key, [structuredClone(value)])
      return structuredClone(value)
    },
    async latestRequest(input) {
      const values = requests.get(`${input.tenantId}\0${input.requestId}`)
      return values?.length ? structuredClone(values[values.length - 1]!) : null
    },
    async listLatestRequests(input) {
      return [...requests.entries()]
        .filter(([key]) => key.startsWith(`${input.tenantId}\0`))
        .map(([, values]) => structuredClone(values[values.length - 1]!))
        .sort((left, right) => right.created_at - left.created_at || left.request_id.localeCompare(right.request_id))
    },
    async decide(input) {
      const key = `${input.current.tenant_id}\0${input.current.request_id}`
      const values = requests.get(key)
      if (!values || values[values.length - 1]?.revision !== input.current.revision) {
        throw new PlatformApiError("EXECUTION_GRANT_REQUEST_REVISION_CONFLICT", 409)
      }
      const next = {
        ...input.current,
        revision: input.current.revision + 1,
        state: input.decision === "APPROVE" ? "APPROVED" as const : "DENIED" as const,
        decided_by_subject_id: input.actorSubjectId,
        decided_at: input.decidedAt,
        decision_reason: input.reason,
        execution_grant_id: input.grant?.execution_grant_id ?? null,
      }
      values.push(next)
      return structuredClone(next)
    },
  }
}
