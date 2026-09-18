import type {
  CompileEnforcementChainInput,
  CompiledEnforcementChain,
  EnforcementChainInventoryItem,
  EnforcementChainRevisionKey,
} from "./contract"
import type { ResourceConnectionRegistry } from "../connections/module"
import type { ResourceRegistry } from "../resources/module"
import type { SqlTransaction } from "../../persistence/sql-adapter"

/**
 * The compiler resolves the resource and its owned connection through the
 * same capability graph that handles writes.  Keeping these registries at the
 * seam prevents a caller from compiling an arbitrary cross-tenant pair of
 * identifiers into a runtime projection.
 */
export interface EnforcementChainScope {
  resources: ResourceRegistry
  connections: ResourceConnectionRegistry
}

export interface EnforcementChainCompiler {
  compile(input: {
    tenantId: string
    value: CompileEnforcementChainInput
  }): Promise<CompiledEnforcementChain>

  /**
   * Resolve the candidate set for a route before compiling its chain.  The
   * current routing capability has no separate persisted route-policy store,
   * so the implementation returns the Resource-owned Connection inventory;
   * a routing-policy adapter can narrow this set without changing the chain
   * contract later.
   */
  listEligibleConnectionIds(input: {
    tenantId: string
    resourceId: string
  }): Promise<string[]>
}

export interface EnforcementChainRevision {
  tenant_id: string
  resource_id: string
  capability_id: string
  one_policy_revision: number
  chain: CompiledEnforcementChain
  chain_digest: string
  created_at: number
  updated_at: number
}

export interface EnforcementChainReleasePublisher {
  reconcileInTransaction(input: {
    transaction: SqlTransaction
    tenantId: string
    gatewayId: string
    issuedAt: number
  }): Promise<void>
}

/**
 * Immutable persistence for compiled chains.  A save with the same identity
 * and canonical digest is an idempotent replay; a different digest can never
 * overwrite the admitted revision.
 */
export interface EnforcementChainRevisionStore {
  save(input: {
    tenantId: string
    chain: CompiledEnforcementChain
  }): Promise<EnforcementChainRevision>
  get(input: EnforcementChainRevisionKey): Promise<EnforcementChainRevision | null>
}

/** Read the currently editable/publishable revision for one Resource capability. */
export interface EnforcementChainRevisionReader extends EnforcementChainRevisionStore {
  listInventory(input: { tenantId: string }): Promise<EnforcementChainInventoryItem[]>
  getLatest(input: {
    tenantId: string
    resourceId: string
    capabilityId: string
  }): Promise<EnforcementChainRevision | null>
}
