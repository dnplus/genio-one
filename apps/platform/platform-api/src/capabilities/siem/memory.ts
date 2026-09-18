import type { SiemDelivery, SiemDestination } from "./contract"
import type { SiemForwarder } from "./module"

export function createInMemorySiemForwarder(options: { now?: () => number } = {}): SiemForwarder {
  const destinations = new Map<string, SiemDestination>()
  const deliveries: SiemDelivery[] = []
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  return {
    async getDestination({ tenantId }) {
      return destinations.get(tenantId) ?? null
    },
    async configure({ tenantId, configuredBySubjectId, value }) {
      const destination: SiemDestination = {
        ...value,
        event_kinds: [...new Set(value.event_kinds)],
        configured_by: { subject_id: configuredBySubjectId, evidence_level: "VERIFIED" },
        configured_at: now(),
      }
      destinations.set(tenantId, destination)
      return structuredClone(destination)
    },
    async listDeliveries({ tenantId, limit }) {
      return deliveries.filter((delivery) => delivery.tenant_id === tenantId).slice(0, limit)
    },
    async deliverDue() {
      return 0
    },
  }
}
