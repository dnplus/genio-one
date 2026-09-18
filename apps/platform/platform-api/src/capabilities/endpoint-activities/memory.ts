import type { EndpointActivityEvent, EndpointActivityResourceSummary } from "./contract"
import type { EndpointActivityStore } from "./module"
import { canonicalDestination, endpointClient } from "./shared"
import { PlatformApiError } from "../errors"

export function createInMemoryEndpointActivityStore(
  idFactory: () => string = () => `activity-${crypto.randomUUID()}`,
): EndpointActivityStore {
  const events = new Map<string, EndpointActivityEvent>()
  return {
    async record({ tenantId, deviceId, subjectId, event }) {
      const destination = canonicalDestination(event.destination_host)
      const key = JSON.stringify([tenantId, deviceId, event.correlation_id])
      const existing = events.get(key)
      if (existing) {
        if (
          existing.subject_id !== subjectId ||
          existing.destination_host !== destination ||
          existing.route !== event.route ||
          existing.request_count !== event.request_count ||
          existing.bytes_sent !== event.bytes_sent ||
          existing.bytes_received !== event.bytes_received ||
          existing.observed_at !== event.observed_at
        ) throw new PlatformApiError("ENDPOINT_ACTIVITY_CONFLICT", 409)
        return structuredClone(existing)
      }
      const resourceId = `unclassified:${destination}`
      const discovered = [...events.values()].some((candidate) =>
        candidate.tenant_id === tenantId && candidate.resource_id === resourceId)
      const created: EndpointActivityEvent = {
        activity_id: idFactory(),
        correlation_id: event.correlation_id,
        kind: discovered ? "USAGE" : "DISCOVERY",
        tenant_id: tenantId,
        subject_id: subjectId,
        device_id: deviceId,
        destination_host: destination,
        resource_id: resourceId,
        resource_class: "UNCLASSIFIED",
        client: endpointClient(event),
        route: event.route,
        routing_policy_rule_id: null,
        applied_state_revision: event.applied_state_revision,
        applied_policy_version: event.applied_policy_version,
        request_count: event.request_count,
        bytes_sent: event.bytes_sent,
        bytes_received: event.bytes_received,
        observed_at: event.observed_at,
      }
      events.set(key, created)
      return structuredClone(created)
    },
    async inventory({ tenantId, deviceId, recentLimit }) {
      const matching = [...events.values()].filter((event) =>
        event.tenant_id === tenantId && (!deviceId || event.device_id === deviceId))
      const summaries = new Map<string, EndpointActivityResourceSummary>()
      for (const event of matching) {
        const summary = summaries.get(event.resource_id) ?? {
          resource_id: event.resource_id,
          resource_class: event.resource_class,
          destination_hosts: [],
          subjects: [],
          devices: [],
          clients: [],
          routes: [],
          first_seen_at: event.observed_at,
          last_seen_at: event.observed_at,
          request_count: 0,
          bytes_sent: 0,
          bytes_received: 0,
        }
        summary.destination_hosts = [...new Set([...summary.destination_hosts, event.destination_host])].sort()
        summary.subjects = [...new Set([...summary.subjects, event.subject_id])].sort()
        summary.devices = [...new Set([...summary.devices, event.device_id])].sort()
        if (!summary.clients.some((client) => JSON.stringify(client) === JSON.stringify(event.client))) {
          summary.clients = [...summary.clients, event.client].sort((left, right) =>
            JSON.stringify(left).localeCompare(JSON.stringify(right)))
        }
        summary.routes = [...new Set([...summary.routes, event.route])].sort()
        summary.first_seen_at = Math.min(summary.first_seen_at, event.observed_at)
        summary.last_seen_at = Math.max(summary.last_seen_at, event.observed_at)
        summary.request_count += event.request_count
        summary.bytes_sent += event.bytes_sent
        summary.bytes_received += event.bytes_received
        summaries.set(event.resource_id, summary)
      }
      return {
        resources: [...summaries.values()].sort((left, right) => left.resource_id.localeCompare(right.resource_id)),
        recent_activity: matching
          .sort((left, right) => right.observed_at - left.observed_at || right.activity_id.localeCompare(left.activity_id))
          .slice(0, recentLimit)
          .map((event) => structuredClone(event)),
      }
    },
  }
}
