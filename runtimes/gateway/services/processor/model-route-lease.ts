import { randomUUID } from "node:crypto"

import { createClient, type RedisClientType } from "redis"

import type { ProcessingContext } from "./contract"
import type { GatewayRoutingScope } from "../shared/gateway-routing-artifact"

const LEASE_KEY_PREFIX = "genio-one:gateway-model-route-lease:v1"

export interface StoredGatewayModelRouteLease {
  schema_version: 2
  lease_id: string
  tenant_id: string
  subject_id: string
  client_id: string
  resource_id: string
  capability_id: string
  session_id: string
  requested_public_model_id: string
  selected_public_model_id: string
  selected_public_model_name: string
  mapping_id: string
  connection_id: string
  connection_configuration_revision: number
  provider_credential_profile_id?: string
  provider_credential_profile_revision?: number
  provider_credential_strategy_digest?: string
  provider_model: string
  routing_policy_id: string
  routing_revision: number
  routing_generation: number
  candidate_set_digest: string
  issued_at: number
  expires_at: number
}

export interface GatewayModelRouteResolution {
  body: Uint8Array
  lease: StoredGatewayModelRouteLease
  reused: boolean
}

export interface GatewayModelRouteResolver {
  resolve(input: {
    context: ProcessingContext
    scope: GatewayRoutingScope
    body: Uint8Array
    /** Public Model alias received from the Client before classifier steps. */
    requestedPublicModelName?: string
    allowedPublicModels: readonly string[]
  }): Promise<GatewayModelRouteResolution>
  close(): Promise<void>
}

export function gatewayModelRouteLeaseEvent(
  context: ProcessingContext,
  resolution: GatewayModelRouteResolution,
) {
  return {
    event: "genio.one.model-route-lease",
    correlation_id: context.correlationId,
    lease_id: resolution.lease.lease_id,
    routing_policy_id: resolution.lease.routing_policy_id,
    routing_revision: resolution.lease.routing_revision,
    candidate_set_digest: resolution.lease.candidate_set_digest,
    selected_public_model_id: resolution.lease.selected_public_model_id,
    selected_public_model: resolution.lease.selected_public_model_name,
    connection_id: resolution.lease.connection_id,
    provider_credential_profile_id: resolution.lease.provider_credential_profile_id ?? null,
    provider_credential_profile_revision: resolution.lease.provider_credential_profile_revision ?? null,
    provider_model: resolution.lease.provider_model,
    reused: resolution.reused,
  } as const
}

function leaseKey(context: ProcessingContext): string {
  return `${LEASE_KEY_PREFIX}:${JSON.stringify([
    context.tenantId,
    context.subjectId,
    context.clientId,
    context.resourceId,
    context.capabilityId,
    context.sessionId,
  ])}`
}

function requestBody(body: Uint8Array): { value: Record<string, unknown>; model: string } {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(body).toString("utf8")) as unknown
  } catch {
    throw new Error("AI request body is not valid JSON")
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("AI request body must be an object")
  }
  const model = (value as Record<string, unknown>).model
  if (typeof model !== "string" || !model.trim() || /[\u0000\r\n]/.test(model)) {
    throw new Error("AI request body is missing a valid Public Model")
  }
  return { value: value as Record<string, unknown>, model: model.trim() }
}

export function requestPublicModelName(body: Uint8Array): string {
  return requestBody(body).model
}

function storedLease(value: string): StoredGatewayModelRouteLease {
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    throw new Error("stored model route lease is invalid")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("stored model route lease is invalid")
  }
  const lease = parsed as Partial<StoredGatewayModelRouteLease>
  if (
    lease.schema_version !== 2 ||
    typeof lease.lease_id !== "string" ||
    typeof lease.selected_public_model_id !== "string" ||
    typeof lease.requested_public_model_id !== "string" ||
    typeof lease.mapping_id !== "string" ||
    typeof lease.connection_id !== "string" ||
    !Number.isSafeInteger(lease.connection_configuration_revision) ||
    typeof lease.provider_model !== "string" ||
    typeof lease.routing_policy_id !== "string" ||
    !Number.isSafeInteger(lease.routing_revision) ||
    !Number.isSafeInteger(lease.routing_generation) ||
    typeof lease.candidate_set_digest !== "string" ||
    !Number.isSafeInteger(lease.expires_at)
  ) {
    throw new Error("stored model route lease is invalid")
  }
  const profileFields = [
    lease.provider_credential_profile_id,
    lease.provider_credential_profile_revision,
    lease.provider_credential_strategy_digest,
  ]
  if (profileFields.some((entry) => entry !== undefined) && profileFields.some((entry) => entry === undefined)) {
    throw new Error("stored model route lease is invalid")
  }
  if (
    lease.provider_credential_profile_id !== undefined &&
    (
      typeof lease.provider_credential_profile_id !== "string" ||
      !lease.provider_credential_profile_id ||
      !Number.isSafeInteger(lease.provider_credential_profile_revision) ||
      !/^[a-f0-9]{64}$/.test(String(lease.provider_credential_strategy_digest))
    )
  ) {
    throw new Error("stored model route lease is invalid")
  }
  return lease as StoredGatewayModelRouteLease
}

function assertLeaseMatches(
  lease: StoredGatewayModelRouteLease,
  context: ProcessingContext,
  scope: GatewayRoutingScope,
  requestedPublicModelId: string,
  now: number,
): void {
  if (
    lease.tenant_id !== context.tenantId ||
    lease.subject_id !== context.subjectId ||
    lease.client_id !== context.clientId ||
    lease.resource_id !== context.resourceId ||
    lease.capability_id !== context.capabilityId ||
    lease.session_id !== context.sessionId ||
    lease.requested_public_model_id !== requestedPublicModelId ||
    lease.routing_policy_id !== scope.routing_policy_id ||
    lease.routing_revision !== scope.routing_revision ||
    lease.routing_generation !== scope.routing_revision ||
    lease.candidate_set_digest !== scope.candidate_set_digest ||
    lease.expires_at <= now
  ) {
    throw new Error("session model route lease conflicts with the current request or policy")
  }
  const candidate = scope.candidates.find(
    (entry) => entry.public_model_id === lease.selected_public_model_id,
  )
  if (!candidate?.mappings.some(
    (mapping) =>
      mapping.mapping_id === lease.mapping_id &&
      mapping.connection_id === lease.connection_id &&
      (mapping.connection_configuration_revision ?? 1) === lease.connection_configuration_revision &&
      mapping.provider_credential_profile_id === lease.provider_credential_profile_id &&
      mapping.provider_credential_profile_revision === lease.provider_credential_profile_revision &&
      mapping.provider_credential_strategy_digest === lease.provider_credential_strategy_digest &&
      mapping.provider_model === lease.provider_model,
  )) {
    throw new Error("session model route lease is no longer eligible")
  }
}

export class ValkeyGatewayModelRouteResolver implements GatewayModelRouteResolver {
  private readonly client: RedisClientType

  constructor(origin: string, client?: RedisClientType) {
    this.client = client ?? createClient({ url: origin })
  }

  async resolve(input: {
    context: ProcessingContext
    scope: GatewayRoutingScope
    body: Uint8Array
    requestedPublicModelName?: string
    allowedPublicModels: readonly string[]
  }): Promise<GatewayModelRouteResolution> {
    if (input.scope.route_mode !== "SESSION_LEASE" || !input.scope.session_lease) {
      throw new Error("Gateway route scope is not session based")
    }
    const request = requestBody(input.body)
    const requestedName = input.requestedPublicModelName ?? request.model
    const requested = input.scope.candidates.find(
      (candidate) => candidate.public_model_name === requestedName,
    )
    if (!requested) throw new Error("requested Public Model is not routable")
    if (
      input.allowedPublicModels.length > 0 &&
      !input.allowedPublicModels.includes(request.model)
    ) {
      throw new Error("requested Public Model is not in the authorized candidate set")
    }
    const selected = input.scope.candidates.find(
      (candidate) => candidate.public_model_name === request.model,
    )
    if (!selected) throw new Error("classified Public Model is not routable")

    if (!this.client.isOpen) await this.client.connect()
    const key = leaseKey(input.context)
    const now = Math.floor(Date.now() / 1_000)
    const existing = await this.client.get(key)
    if (existing) {
      const lease = storedLease(existing)
      assertLeaseMatches(lease, input.context, input.scope, requested.public_model_id, now)
      request.value.model = lease.selected_public_model_name
      return { body: Buffer.from(JSON.stringify(request.value)), lease, reused: true }
    }

    const mapping = selected.mappings[0]
    if (!mapping) throw new Error("selected Public Model has no Connection mapping")
    const ttl = input.scope.session_lease.ttl_seconds
    const lease: StoredGatewayModelRouteLease = {
      schema_version: 2,
      lease_id: `route-lease-${randomUUID()}`,
      tenant_id: input.context.tenantId,
      subject_id: input.context.subjectId,
      client_id: input.context.clientId,
      resource_id: input.context.resourceId,
      capability_id: input.context.capabilityId,
      session_id: input.context.sessionId,
      requested_public_model_id: requested.public_model_id,
      selected_public_model_id: selected.public_model_id,
      selected_public_model_name: selected.public_model_name,
      mapping_id: mapping.mapping_id,
      connection_id: mapping.connection_id,
      connection_configuration_revision: mapping.connection_configuration_revision ?? 1,
      ...(mapping.provider_credential_profile_id ? {
        provider_credential_profile_id: mapping.provider_credential_profile_id,
        provider_credential_profile_revision: mapping.provider_credential_profile_revision!,
        provider_credential_strategy_digest: mapping.provider_credential_strategy_digest!,
      } : {}),
      provider_model: mapping.provider_model,
      routing_policy_id: input.scope.routing_policy_id,
      routing_revision: input.scope.routing_revision,
      routing_generation: input.scope.routing_revision,
      candidate_set_digest: input.scope.candidate_set_digest,
      issued_at: now,
      expires_at: now + ttl,
    }
    const acquired = await this.client.set(key, JSON.stringify(lease), { NX: true, EX: ttl })
    if (acquired !== "OK") {
      const winner = await this.client.get(key)
      if (!winner) throw new Error("model route lease winner is unavailable")
      const winningLease = storedLease(winner)
      assertLeaseMatches(
        winningLease,
        input.context,
        input.scope,
        requested.public_model_id,
        now,
      )
      request.value.model = winningLease.selected_public_model_name
      return { body: Buffer.from(JSON.stringify(request.value)), lease: winningLease, reused: true }
    }
    request.value.model = selected.public_model_name
    return { body: Buffer.from(JSON.stringify(request.value)), lease, reused: false }
  }

  async close(): Promise<void> {
    if (this.client.isOpen) await this.client.quit()
  }
}
