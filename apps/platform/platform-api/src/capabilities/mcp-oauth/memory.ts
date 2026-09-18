import type {
  McpOAuthBindingRecord,
  McpOAuthSessionRecord,
  McpOAuthStore,
} from "./module"

function sessionKey(tenantId: string, sessionId: string): string {
  return JSON.stringify([tenantId, sessionId])
}

function bindingKey(tenantId: string, connectionId: string, subjectId: string): string {
  return JSON.stringify([tenantId, connectionId, subjectId])
}

export function createInMemoryMcpOAuthStore(): McpOAuthStore {
  const sessions = new Map<string, McpOAuthSessionRecord>()
  const bindings = new Map<string, McpOAuthBindingRecord>()
  return {
    async createSession(value) {
      sessions.set(sessionKey(value.tenant_id, value.session_id), structuredClone(value))
    },
    async getSessionById(input) {
      return structuredClone(sessions.get(sessionKey(input.tenantId, input.sessionId)) ?? null)
    },
    async getSessionByStateHash(value) {
      const session = [...sessions.values()].find((candidate) => candidate.state_hash === value)
      return structuredClone(session ?? null)
    },
    async updateSession(value) {
      sessions.set(sessionKey(value.tenant_id, value.session_id), structuredClone(value))
    },
    async deleteSession(input) {
      sessions.delete(sessionKey(input.tenantId, input.sessionId))
    },
    async putBinding(value) {
      bindings.set(bindingKey(value.tenant_id, value.connection_id, value.subject_id), structuredClone(value))
    },
    async updateBindingIfCurrent(previous, value) {
      const key = bindingKey(previous.tenant_id, previous.connection_id, previous.subject_id)
      if (bindings.get(key)?.sealed_state !== previous.sealed_state) return false
      bindings.set(key, structuredClone(value))
      return true
    },
    async getBinding(input) {
      return structuredClone(bindings.get(bindingKey(input.tenantId, input.connectionId, input.subjectId)) ?? null)
    },
    async deleteBinding(input) {
      bindings.delete(bindingKey(input.tenantId, input.connectionId, input.subjectId))
    },
    async listBindings(input) {
      return [...bindings.values()]
        .filter((binding) =>
          binding.tenant_id === input.tenantId &&
          binding.resource_id === input.resourceId &&
          binding.subject_id === input.subjectId)
        .map((binding) => structuredClone(binding))
    },
  }
}
