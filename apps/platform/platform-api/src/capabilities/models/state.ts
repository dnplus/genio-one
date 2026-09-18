import type { ConnectionModelMapping, PublicModel } from "./contract"
import type { ModelRouteLease } from "../model-routing/contract"

export interface ModelMemoryState {
  models: Map<string, PublicModel>
  mappings: Map<string, ConnectionModelMapping>
  leases: Map<string, ModelRouteLease>
  modelSequence: number
  mappingSequence: number
  leaseSequence: number
}

export function createModelMemoryState(): ModelMemoryState {
  return {
    models: new Map(),
    mappings: new Map(),
    leases: new Map(),
    modelSequence: 0,
    mappingSequence: 0,
    leaseSequence: 0,
  }
}
