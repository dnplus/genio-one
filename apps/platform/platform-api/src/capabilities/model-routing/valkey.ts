import { randomUUID } from "node:crypto"

import { Check } from "typebox/value"

import { PlatformApiError } from "../errors"
import type { PublicModelCatalog } from "../models/module"
import {
  ModelRouteLeaseSchema,
  type ModelRouteLease,
  type ResolveModelRouteInput,
} from "./contract"
import type { ModelRouter } from "./module"
import { prepareModelRoute, type RoutableModel } from "./candidates"

const DEFAULT_LEASE_SECONDS = 3_600
const MAX_LEASE_SECONDS = 86_400
const LEASE_KEY_PREFIX = "genio-one:model-route-lease:v1"

/**
 * The adapter deliberately accepts only the two Redis operations it needs.
 * A connected node-redis client and a Valkey client both satisfy this seam;
 * connection lifecycle and retry policy remain outside model routing.
 */
export interface ValkeySessionLeaseClient {
  get(key: string): Promise<string | null>
  set(
    key: string,
    value: string,
    options: { NX: true; EX: number },
  ): Promise<"OK" | null>
}

export interface ValkeyModelRouterOptions {
  client: ValkeySessionLeaseClient
  models: PublicModelCatalog
  now?: () => number
  defaultLeaseSeconds?: number
  idFactory?: () => string
}

export interface ModelRouteLeaseKeyInput {
  tenantId: string
  subjectId: string
  clientId: string
  publicModelId: string
  sessionId: string
}

/**
 * Keep every lease scope component in the key. JSON array encoding avoids
 * delimiter ambiguity for identifiers supplied by different tenants.
 */
export function valkeyModelRouteLeaseKey(input: ModelRouteLeaseKeyInput): string {
  return `${LEASE_KEY_PREFIX}:${JSON.stringify([
    input.tenantId,
    input.subjectId,
    input.clientId,
    input.publicModelId,
    input.sessionId,
  ])}`
}

function leaseSeconds(value: number | undefined, fallback: number): number {
  const seconds = value ?? fallback
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > MAX_LEASE_SECONDS) {
    throw new PlatformApiError(
      "MODEL_ROUTE_LEASE_TTL_INVALID",
      422,
      `A model route lease must be between 1 and ${MAX_LEASE_SECONDS} seconds`,
    )
  }
  return seconds
}

function unavailable(message: string): PlatformApiError {
  return new PlatformApiError("MODEL_ROUTE_LEASE_UNAVAILABLE", 503, message)
}

function invalidStoredLease(): PlatformApiError {
  return unavailable("The stored model route lease is invalid")
}

function validateStoredLease(
  encoded: string,
  keyContext: ModelRouteLeaseKeyInput,
  currentTime: number,
): ModelRouteLease | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(encoded) as unknown
  } catch {
    throw invalidStoredLease()
  }

  if (!Check(ModelRouteLeaseSchema, parsed)) throw invalidStoredLease()
  if (
    parsed.route_mode !== "SESSION_LEASE" ||
    parsed.tenant_id !== keyContext.tenantId ||
    parsed.subject_id !== keyContext.subjectId ||
    parsed.client_id !== keyContext.clientId ||
    parsed.public_model_id !== keyContext.publicModelId ||
    parsed.session_id !== keyContext.sessionId ||
    parsed.expires_at === undefined
  ) {
    throw invalidStoredLease()
  }

  // A valid-but-expired value is safe to replace only if SET NX can acquire
  // the key. It is kept distinct from corrupt data so a proper Redis TTL can
  // naturally remove it without making the adapter delete another writer's key.
  return parsed.expires_at > currentTime ? parsed : undefined
}

async function readLease(
  client: ValkeySessionLeaseClient,
  key: string,
  keyContext: ModelRouteLeaseKeyInput,
  currentTime: number,
): Promise<ModelRouteLease | undefined> {
  let encoded: string | null
  try {
    encoded = await client.get(key)
  } catch {
    throw unavailable("The model route lease store could not be read")
  }
  if (encoded === null) return undefined
  return validateStoredLease(encoded, keyContext, currentTime)
}

function assertExistingLeaseIsEligible(
  lease: ModelRouteLease,
  candidates: readonly RoutableModel[],
  requestedPublicModelId: string | undefined,
): void {
  if (
    requestedPublicModelId !== undefined &&
    requestedPublicModelId !== lease.selected_public_model_id
  ) {
    throw new PlatformApiError(
      "SESSION_MODEL_LEASE_EXISTS",
      409,
      "A model route is sticky for the session; start a new session to switch models",
    )
  }

  const candidate = candidates.find(
    (candidate) =>
      candidate.model.model_id === lease.selected_public_model_id &&
      candidate.mapping.mapping_id === lease.mapping_id,
  )
  if (
    !candidate ||
    candidate.model.resource_id !== lease.resource_id ||
    candidate.mapping.connection_id !== lease.connection_id ||
    candidate.mapping.provider_model !== lease.provider_model ||
    candidate.mapping.mapping_revision !== lease.mapping_revision
  ) {
    throw new PlatformApiError(
      "SESSION_MODEL_ROUTE_CONFLICT",
      409,
      "The current session route is not eligible for this request",
    )
  }
}

export function createValkeyModelRouter(options: ValkeyModelRouterOptions): ModelRouter {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const defaultLease = leaseSeconds(options.defaultLeaseSeconds, DEFAULT_LEASE_SECONDS)
  const idFactory = options.idFactory ?? (() => `model-lease-${randomUUID()}`)

  return {
    async resolve(input: { tenantId: string; value: ResolveModelRouteInput }) {
      const currentTime = now()
      const prepared = await prepareModelRoute(options.models, input.tenantId, input.value, currentTime)
      if (prepared.deterministic) return prepared.deterministic
      const { candidates, context } = prepared

      const sessionId = prepared.sessionId
      const keyContext: ModelRouteLeaseKeyInput = {
        tenantId: input.tenantId,
        subjectId: context.subjectId,
        clientId: context.clientId,
        publicModelId: context.publicModelId,
        sessionId,
      }
      const key = valkeyModelRouteLeaseKey(keyContext)
      const current = await readLease(options.client, key, keyContext, currentTime)
      if (current) {
        assertExistingLeaseIsEligible(
          current,
          candidates,
          input.value.requested_public_model_id,
        )
        return { ...current, reused: true }
      }

      const selected = candidates[0]
      if (!selected) throw new PlatformApiError("NO_ELIGIBLE_MODEL", 403)

      const ttl = leaseSeconds(input.value.lease_seconds, defaultLease)
      const lease: ModelRouteLease = {
        tenant_id: input.tenantId,
        lease_id: idFactory(),
        subject_id: context.subjectId,
        client_id: context.clientId,
        public_model_id: context.publicModelId,
        selected_public_model_id: selected.model.model_id,
        session_id: sessionId,
        mapping_id: selected.mapping.mapping_id,
        provider_model: selected.mapping.provider_model,
        mapping_revision: selected.mapping.mapping_revision,
        resource_id: selected.model.resource_id,
        connection_id: selected.mapping.connection_id,
        issued_at: currentTime,
        expires_at: currentTime + ttl,
        reused: false,
        route_mode: "SESSION_LEASE",
      }

      let acquired: "OK" | null
      try {
        // SET NX EX is the single atomic ownership operation. A failed NX
        // result is always followed by a read of the winner; we never return
        // the locally generated lease when another request won the race.
        acquired = await options.client.set(key, JSON.stringify(lease), {
          NX: true,
          EX: ttl,
        })
      } catch {
        throw unavailable("The model route lease store could not be written")
      }
      if (acquired === "OK") return lease

      const winner = await readLease(options.client, key, keyContext, currentTime)
      if (!winner) {
        throw unavailable("The model route lease winner could not be read")
      }
      assertExistingLeaseIsEligible(
        winner,
        candidates,
        input.value.requested_public_model_id,
      )
      return { ...winner, reused: true }
    },
  }
}
