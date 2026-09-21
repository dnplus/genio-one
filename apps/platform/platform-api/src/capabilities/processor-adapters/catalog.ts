import {
  sanitizeProcessorAdapterCatalog,
  type ProcessorAdapterKind,
  type ProcessorAdapterRegistry,
} from "../../../../../../runtimes/gateway/services/shared/processor-adapters"

export interface ProcessorAdapterCatalogEntry {
  id: string
  kind: ProcessorAdapterKind
  endpoint: string
  model?: string
}

export interface ProcessorAdapterCatalog {
  list(input: { tenantId: string }): Promise<ProcessorAdapterCatalogEntry[]>
  get(input: { tenantId: string; adapterId: string }): Promise<ProcessorAdapterCatalogEntry | null>
}

function entry(value: {
  id: string
  kind: ProcessorAdapterKind
  endpoint: string
  model?: string
}): ProcessorAdapterCatalogEntry {
  return {
    id: value.id,
    kind: value.kind,
    endpoint: value.endpoint,
    ...(value.model ? { model: value.model } : {}),
  }
}

export function createProcessorAdapterCatalog(
  registry: ProcessorAdapterRegistry,
): ProcessorAdapterCatalog {
  const adapters = sanitizeProcessorAdapterCatalog(registry)
  return {
    async list({ tenantId }) {
      return adapters
        .filter((adapter) => adapter.tenant_id === tenantId)
        .map(entry)
    },
    async get({ tenantId, adapterId }) {
      const adapter = adapters.find((candidate) =>
        candidate.tenant_id === tenantId && candidate.id === adapterId
      )
      return adapter ? entry(adapter) : null
    },
  }
}
