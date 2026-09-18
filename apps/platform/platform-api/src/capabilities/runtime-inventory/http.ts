import type { FastifyPluginAsync } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"

import type { RuntimeControlStore, RuntimeRegistration } from "../runtime-control/contract"
import type { GatewayAggregateRuntimeControlStore } from "../gateway-runtime-control/contract"
import type { GatewayRegistrationLifecycle } from "../gateway-registration/module"
import {
  GatewayFleetSchema,
  RuntimeInventoryPathSchema,
  RuntimeInventorySchema,
} from "./contract"

type RuntimeEntry = {
  runtime_id: string
  runtime_kind: "GATEWAY"
  gateway_id: string
  release_eligible: boolean
  connected: boolean
  pending_command_count: number
  desired_state_revision: string | null
  desired_policy_version: string | null
  last_successful_state_revision: string | null
  observed_state: {
    command_id: string
    runtime_id: string
    runtime_kind: "GATEWAY"
    runtime_version: string
    applied_state_revision: string | null
    applied_policy_version: string | null
    health: "READY" | "DEGRADED"
    components: Array<{
      component: string
      applied_config_revision: string | null
      applied_enforcement_bundle_revision: string | null
      health: "READY" | "DEGRADED"
      detail: string | null
    }>
  } | null
  last_reported_at: number | null
  operator_state: "READY" | "DEGRADED" | "AWAITING_REPORT" | "OFFLINE" | "OUT_OF_SYNC"
  in_sync: boolean
  health_timed_out: boolean
  health_timeout_seconds: number
  last_error: string | null
  remediation_hint: string | null
  operator_alert_code: "RUNTIME_HEALTH_TIMEOUT" | "RUNTIME_DISCONNECTED" | "RUNTIME_CONFIGURATION_OUT_OF_SYNC" | "RUNTIME_DEGRADED" | null
}

export function desiredRuntimeStateRevision(input: {
  pendingRevision: string | null
  observedRevision: string | null
  appliedRevision: string | null
}): string | null {
  return input.pendingRevision ?? input.observedRevision ?? input.appliedRevision
}

export function runtimeHealthTimedOut(input: {
  connected: boolean
  observedAt: number | null
  now: number
  timeoutSeconds: number
}): boolean {
  return input.connected && input.observedAt !== null && input.now - input.observedAt >= input.timeoutSeconds
}

async function entry(
  registration: RuntimeRegistration,
  runtimeControl: RuntimeControlStore,
  aggregate: GatewayAggregateRuntimeControlStore | undefined,
  now: number,
): Promise<RuntimeEntry> {
  const input = { tenantId: registration.tenant_id, runtimeKind: "GATEWAY" as const, runtimeId: registration.runtime_id }
  const [lease, observed, pending, capabilities] = await Promise.all([
    runtimeControl.getGatewaySessionLease(input),
    aggregate?.getLatestGatewayReleaseObserved(input) ?? Promise.resolve(null),
    aggregate?.listPendingGatewayReleaseCommands(input) ?? Promise.resolve([]),
    aggregate?.getCapabilities(input) ?? Promise.resolve(null),
  ])
  const connected = lease !== null
  const observedState = observed?.observed_status.state
  const appliedRevision = observed?.applied_release
    ? String(observed.applied_release.head_revision)
    : null
  const desiredRevision = desiredRuntimeStateRevision({
    pendingRevision: pending.at(-1)?.command.revision ?? null,
    observedRevision: observed?.revision ?? null,
    appliedRevision,
  })
  const healthTimeoutSeconds = 30
  const healthTimedOut = runtimeHealthTimedOut({
    connected,
    observedAt: observed?.observed_at ?? null,
    now,
    timeoutSeconds: healthTimeoutSeconds,
  })
  const inSync = connected && !healthTimedOut && observedState === "READY" && pending.length === 0
  const operatorState: RuntimeEntry["operator_state"] = !connected
    ? "OFFLINE"
    : healthTimedOut
      ? "DEGRADED"
    : !observed
      ? "AWAITING_REPORT"
      : observedState === "DEGRADED"
        ? "DEGRADED"
        : inSync
          ? "READY"
          : "OUT_OF_SYNC"
  const alert: RuntimeEntry["operator_alert_code"] = healthTimedOut
    ? "RUNTIME_HEALTH_TIMEOUT"
    : operatorState === "OFFLINE"
    ? "RUNTIME_DISCONNECTED"
    : operatorState === "DEGRADED"
      ? "RUNTIME_DEGRADED"
      : operatorState === "OUT_OF_SYNC"
        ? "RUNTIME_CONFIGURATION_OUT_OF_SYNC"
        : null
  const lastError = observed?.observed_status.components
    ?.find((component) => component.state !== "READY" && component.detail)?.detail ?? null
  const remediationHint = alert === "RUNTIME_HEALTH_TIMEOUT"
    ? "RESTORE_CONTROL_CHANNEL_AND_WAIT_FOR_FRESH_REPORT"
    : alert === "RUNTIME_DISCONNECTED"
      ? "RECONNECT_RUNTIME"
      : alert === "RUNTIME_CONFIGURATION_OUT_OF_SYNC"
        ? "REAPPLY_DESIRED_RELEASE"
        : alert === "RUNTIME_DEGRADED"
          ? "INSPECT_DEGRADED_COMPONENTS"
          : null
  return {
    runtime_id: registration.runtime_id,
    runtime_kind: "GATEWAY",
    gateway_id: registration.target_id,
    release_eligible: registration.status === "ACTIVE" &&
      capabilities?.preferred_protocol_version === "genio.one.runtime.v1" &&
      capabilities.delivery_mode === "AGGREGATE_RELEASE",
    connected,
    pending_command_count: pending.length,
    desired_state_revision: desiredRevision,
    desired_policy_version: null,
    last_successful_state_revision: appliedRevision,
    observed_state: observed
      ? {
          command_id: observed.command_id,
          runtime_id: observed.runtime_id,
          runtime_kind: "GATEWAY",
          runtime_version: "—",
          applied_state_revision: appliedRevision,
          applied_policy_version: null,
          health: observedState === "READY" ? "READY" : "DEGRADED",
          components: (observed.observed_status.components ?? []).map((component) => ({
            component: component.component,
            applied_config_revision: component.observed_revision,
            applied_enforcement_bundle_revision: null,
            health: component.state === "READY" ? "READY" : "DEGRADED",
            detail: component.detail ?? null,
          })),
        }
      : null,
    last_reported_at: observed?.observed_at ?? null,
    operator_state: operatorState,
    in_sync: inSync,
    health_timed_out: healthTimedOut,
    health_timeout_seconds: healthTimeoutSeconds,
    last_error: lastError,
    remediation_hint: remediationHint,
    operator_alert_code: alert,
  }
}

export const runtimeInventoryHttp: FastifyPluginAsync<{
  runtimeControl: RuntimeControlStore
  aggregate?: GatewayAggregateRuntimeControlStore
  gatewayRegistrations?: Pick<GatewayRegistrationLifecycle, "list">
  now?: () => number
}> = async (app, options) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()
  const load = async (tenantId: string) => {
    const registrations = await options.runtimeControl.listGatewayRuntimes({ tenantId })
    const runtimes = await Promise.all(
      registrations.map((registration) => entry(
        registration,
        options.runtimeControl,
        options.aggregate,
        options.now?.() ?? Math.floor(Date.now() / 1000),
      )),
    )
    return { registrations, runtimes }
  }
  routes.get("/v1/tenants/:tenant_id/runtimes", {
    schema: { tags: ["Runtime Control"], params: RuntimeInventoryPathSchema, response: { 200: RuntimeInventorySchema } },
  }, async (request) => (await load(request.params.tenant_id)).runtimes)
  routes.get("/v1/tenants/:tenant_id/gateway-sites", {
    schema: { tags: ["Runtime Control"], params: RuntimeInventoryPathSchema, response: { 200: GatewayFleetSchema } },
  }, async (request) => {
    const { registrations, runtimes } = await load(request.params.tenant_id)
    const managedRegistrations = await options.gatewayRegistrations?.list({
      tenantId: request.params.tenant_id,
    }) ?? []
    const metadataByRuntime = new Map(
      managedRegistrations
        .filter((registration) => registration.state === "ACTIVE")
        .map((registration) => [registration.runtime_id, registration]),
    )
    const activeRegistrations = registrations.filter((registration) => registration.status === "ACTIVE")
    const groups = new Map<string, {
      gatewayId: string
      siteId: string
      region: string
      runtimeIds: string[]
    }>()
    for (const registration of activeRegistrations) {
      const metadata = metadataByRuntime.get(registration.runtime_id)
      const gatewayId = metadata?.gateway_id ?? registration.target_id
      const siteId = metadata?.site_id ?? registration.target_id
      const region = metadata?.region ?? "unassigned"
      const key = `${gatewayId}\u0000${siteId}\u0000${region}`
      const group = groups.get(key) ?? { gatewayId, siteId, region, runtimeIds: [] }
      group.runtimeIds.push(registration.runtime_id)
      groups.set(key, group)
    }
    const sites = [...groups.values()].map((group) => {
      const siteRuntimes = runtimes.filter((runtime) =>
        group.runtimeIds.includes(runtime.runtime_id)
      )
      const ready = siteRuntimes.filter((runtime) => runtime.operator_state === "READY")
      return {
        gateway_id: group.gatewayId,
        site_id: group.siteId,
        region: group.region,
        operator_state: ready.length > 0 ? "READY" as const : siteRuntimes.some((runtime) => runtime.connected) ? "DEGRADED" as const : "DOWN" as const,
        traffic_available: ready.length > 0,
        registered_instance_count: siteRuntimes.length,
        traffic_eligible_instance_count: ready.length,
        traffic_candidates: ready.map((runtime) => runtime.runtime_id),
        instances: siteRuntimes.map((runtime) => ({
          runtime_id: runtime.runtime_id,
          operator_state: runtime.operator_state,
          traffic_eligible: runtime.operator_state === "READY",
          alert_code: runtime.operator_alert_code,
        })),
      }
    })
    const trafficAvailable = sites.some((site) => site.traffic_available)
    return {
      tenant_id: request.params.tenant_id,
      operator_state: sites.length === 0 ? "NO_GATEWAYS" as const : trafficAvailable ? "READY" as const : sites.some((site) => site.operator_state === "DEGRADED") ? "DEGRADED" as const : "DOWN" as const,
      traffic_available: trafficAvailable,
      sites,
    }
  })
}
