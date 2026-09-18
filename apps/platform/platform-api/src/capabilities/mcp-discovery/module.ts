import type {
  CompleteMcpDiscoveryInput,
  McpDiscoveryOperation,
} from "./contract"

export interface McpDiscoveryStore {
  request(input: {
    tenantId: string
    resourceId: string
    connectionId: string
    requestedBySubjectId: string
    correlationId: string
  }): Promise<McpDiscoveryOperation>
  latest(input: {
    tenantId: string
    resourceId: string
    connectionId: string
  }): Promise<McpDiscoveryOperation | null>
  get(input: {
    tenantId: string
    operationId: string
  }): Promise<McpDiscoveryOperation | null>
  claimNext(input: {
    tenantId: string
    gatewayId: string
    runtimeId: string
  }): Promise<McpDiscoveryOperation | null>
  complete(input: {
    tenantId: string
    runtimeId: string
    operationId: string
    result: CompleteMcpDiscoveryInput
  }): Promise<McpDiscoveryOperation>
  decideCandidate(input: {
    tenantId: string
    resourceId: string
    connectionId: string
    candidateId: string
    expectedRevisionDigest: string
    state: "PUBLISHED" | "IGNORED" | "BLOCKED"
  }): Promise<McpDiscoveryOperation>
}
