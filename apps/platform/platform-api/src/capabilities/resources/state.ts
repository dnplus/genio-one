import type { ResourceRegistration } from "./contract"
import type { ResourcePublicationRequest } from "./publication-types"
import type { ConnectionRegistration } from "../connections/contract"
import type { GatewayProjection } from "../gateway-projection/contract"
import type { GatewayProjectionSnapshot } from "../gateway-projection/contract"

export interface ResourcePublicationBuildAttempt {
  tenant_id: string
  publication_id: string
  attempt_id: string
  snapshot_digest: string
  state: "BUILDING" | "FAILED" | "READY"
  projection_digest?: string
  failure_code?: string
  claimed_at: number
  completed_at?: number
}

/**
 * Transitional storage shape shared by the Resource and Connection adapters.
 * It is deliberately an implementation detail; callers use the capability
 * interfaces rather than reaching into these maps.
 */
export interface ResourceMemoryState {
  resources: Map<string, ResourceRegistration>
  connections: Map<string, ConnectionRegistration>
  publicationRequests: Map<string, ResourcePublicationRequest>
  publicationSnapshots: Map<string, GatewayProjectionSnapshot>
  publicationAttempts: Map<string, ResourcePublicationBuildAttempt>
  publicationProjections: Map<string, GatewayProjection>
  publicationEndpointRevisions: Map<string, number>
  /** Monotonic governed-content revision used by review snapshots. */
  resourceRevisions: Map<string, number>
  resourceSequence: number
  connectionSequence: number
  publicationSequence: number
}

export function createResourceMemoryState(): ResourceMemoryState {
  return {
    resources: new Map(),
    connections: new Map(),
    publicationRequests: new Map(),
    publicationSnapshots: new Map(),
    publicationAttempts: new Map(),
    publicationProjections: new Map(),
    publicationEndpointRevisions: new Map(),
    resourceRevisions: new Map(),
    resourceSequence: 0,
    connectionSequence: 0,
    publicationSequence: 0,
  }
}
