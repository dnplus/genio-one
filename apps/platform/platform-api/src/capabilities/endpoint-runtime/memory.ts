import { randomUUID } from "node:crypto"
import { assertCredential, credentialHash, issueCredential, type EndpointCredentialRecord } from "./credentials"
import { PlatformApiError } from "../errors"
import type { RegisteredEndpoint, EndpointLifecycleEvent } from "./contract"
import { endpointRuntimeConfiguration, type EndpointRuntimeStore, type EndpointRuntimeStoreOptions } from "./module"
import { assertAppliedState, assertEndpointAcknowledged, assertEndpointSubject } from "./shared"

export function createInMemoryEndpointRuntimeStore(
  options: EndpointRuntimeStoreOptions = {},
): EndpointRuntimeStore {
  const configuration = endpointRuntimeConfiguration(options)
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const devices = new Map<string, RegisteredEndpoint>()
  const credentials = new Map<string, EndpointCredentialRecord>()
  const bootstraps = new Set<string>()
  const events: EndpointLifecycleEvent[] = []
  return {
    async bootstrap({ tenantId, subjectId, correlationId }) {
      const key = JSON.stringify([tenantId, subjectId, correlationId])
      if (bootstraps.has(key)) throw new PlatformApiError("ENDPOINT_BOOTSTRAP_ALREADY_DELIVERED", 409)
      const deviceId = randomUUID()
      const issued = issueCredential({ tenantId, subjectId, deviceId, kind: "BOOTSTRAP" }, now())
      credentials.set(issued.record.credentialId, issued.record)
      bootstraps.add(key)
      return { tenant_id: tenantId, device_id: deviceId, subject_id: subjectId, credential: issued.credential }
    },
    async authenticateCredential({ tenantId, token }) {
      const record = assertCredential([...credentials.values()].find((row) => row.tokenHash === credentialHash(token)), tenantId, now())
      if (record.kind === "RUNTIME") {
        const device = devices.get(JSON.stringify([tenantId, record.deviceId]))
        if (!device || device.lifecycle_state !== "ACTIVE") throw new PlatformApiError("DEVICE_REVOKED", 403)
      }
      const { tokenHash, consumedAt, revokedAt, ...identity } = record
      return identity
    },
    async rotateCredential({ tenantId, deviceId, credentialId }) {
      const old = assertCredential(credentials.get(credentialId), tenantId, now())
      const device = devices.get(JSON.stringify([tenantId, deviceId]))
      if (old.kind !== "RUNTIME" || old.deviceId !== deviceId || !device || device.lifecycle_state !== "ACTIVE") {
        throw new PlatformApiError("ENDPOINT_CREDENTIAL_REJECTED", 401)
      }
      const issued = issueCredential({ tenantId, deviceId, subjectId: old.subjectId, kind: "RUNTIME" }, now())
      old.revokedAt = now()
      credentials.set(issued.record.credentialId, issued.record)
      return issued.credential
    },
    async list({ tenantId }) {
      return structuredClone([...devices.values()].filter((device) => device.tenant_id === tenantId)
        .sort((a, b) => a.device_id.localeCompare(b.device_id)))
    },
    async get({ tenantId, deviceId }) {
      const device = devices.get(JSON.stringify([tenantId, deviceId]))
      if (!device) throw new PlatformApiError("DEVICE_NOT_FOUND", 404)
      return structuredClone(device)
    },
    async lifecycleEvents({ tenantId, deviceId }) {
      if (!devices.has(JSON.stringify([tenantId, deviceId]))) throw new PlatformApiError("DEVICE_NOT_FOUND", 404)
      return structuredClone(events.filter((event) => event.tenant_id === tenantId && event.device_id === deviceId))
    },
    async revoke({ tenantId, deviceId, subjectId, correlationId, reason }) {
      if (!reason.trim()) throw new PlatformApiError("ENDPOINT_REVOCATION_REASON_REQUIRED", 422)
      const device = devices.get(JSON.stringify([tenantId, deviceId]))
      if (!device) throw new PlatformApiError("DEVICE_NOT_FOUND", 404)
      if (device.lifecycle_state === "REVOKED") return structuredClone(device)
      device.lifecycle_state = "REVOKED"
      device.revocation_reason = reason
      for (const credential of credentials.values()) {
        if (credential.tenantId === tenantId && credential.deviceId === deviceId) credential.revokedAt = now()
      }
      events.push({ tenant_id: tenantId, device_id: deviceId, subject_id: subjectId,
        correlation_id: correlationId, kind: "REVOKED", reason, at: now() })
      return structuredClone(device)
    },
    async assertApplied({ tenantId, deviceId, subjectId, appliedStateRevision, appliedPolicyVersion }) {
      const device = devices.get(JSON.stringify([tenantId, deviceId]))
      if (!device) throw new PlatformApiError("DEVICE_NOT_FOUND", 404)
      if (device.lifecycle_state === "REVOKED") throw new PlatformApiError("DEVICE_REVOKED", 403)
      if (device.subject_id !== subjectId) throw new PlatformApiError("ENDPOINT_SUBJECT_EVIDENCE_INVALID", 403)
      assertEndpointAcknowledged(device, configuration.desired_state, now(), configuration.stale_after_seconds)
      assertAppliedState(appliedStateRevision, appliedPolicyVersion, configuration.desired_state)
    },
    async enroll({ tenantId, subjectId, credentialId, value }) {
      if (
        value.identity.subject.evidence_level !== "VERIFIED" ||
        value.identity.subject.subject_id !== subjectId
      ) throw new PlatformApiError("ENDPOINT_SUBJECT_EVIDENCE_INVALID", 403)
      const credential = assertCredential(credentials.get(credentialId), tenantId, now())
      if (credential.subjectId !== subjectId || credential.deviceId !== value.device_id) throw new PlatformApiError("ENDPOINT_CREDENTIAL_REJECTED", 401)
      const key = JSON.stringify([tenantId, value.device_id])
      const existing = devices.get(key)
      if (existing) {
        if (existing.subject_id !== subjectId) throw new PlatformApiError("DEVICE_ALREADY_REGISTERED", 409)
        if (existing.lifecycle_state === "REVOKED") throw new PlatformApiError("DEVICE_REVOKED", 403)
        if (credential.kind !== "RUNTIME") throw new PlatformApiError("ENDPOINT_CREDENTIAL_REJECTED", 401)
        return { device: structuredClone(existing), runtime_credential: null, configuration: structuredClone(configuration) }
      }
      if (credential.kind !== "BOOTSTRAP") throw new PlatformApiError("ENDPOINT_CREDENTIAL_REJECTED", 401)
      const at = now()
      const device: RegisteredEndpoint = {
        tenant_id: tenantId,
        device_id: value.device_id,
        subject_id: subjectId,
        lifecycle_state: "ACTIVE",
        enrolled_at: at,
        last_seen_at: at,
        observed_state: {
          endpoint_version: value.endpoint_version,
          applied_state_revision: null,
          applied_policy_version: null,
          health: "UNKNOWN",
          reported_at: at,
        },
        revocation_reason: null,
      }
      const issued = issueCredential({ tenantId, deviceId: value.device_id, subjectId, kind: "RUNTIME" }, at)
      credential.consumedAt = at
      credentials.set(issued.record.credentialId, issued.record)
      devices.set(key, device)
      events.push({ tenant_id: tenantId, device_id: device.device_id, subject_id: subjectId,
        correlation_id: value.correlation_id, kind: "ENROLLED", reason: null, at })
      return { device: structuredClone(device), runtime_credential: issued.credential, configuration: structuredClone(configuration) }
    },
    async heartbeat({ tenantId, deviceId, subjectId, value }) {
      const key = JSON.stringify([tenantId, deviceId])
      const device = devices.get(key)
      if (!device) throw new PlatformApiError("DEVICE_NOT_FOUND", 404)
      assertEndpointSubject(device, subjectId, value)
      if (Boolean(value.applied_state_revision) !== Boolean(value.applied_policy_version)) {
        throw new PlatformApiError("ENDPOINT_OBSERVATION_INVALID", 422)
      }
      const at = now()
      const updated: RegisteredEndpoint = {
        ...device,
        last_seen_at: at,
        observed_state: {
          endpoint_version: value.endpoint_version,
          applied_state_revision: value.applied_state_revision,
          applied_policy_version: value.applied_policy_version,
          health: value.health,
          reported_at: at,
        },
      }
      devices.set(key, updated)
      const applied = value.applied_state_revision === configuration.desired_state.revision &&
        value.applied_policy_version === configuration.desired_state.policy_version
      return {
        device: structuredClone(updated),
        desired_state: applied ? null : structuredClone(configuration.desired_state),
      }
    },
    async enforce({ tenantId, deviceId, subjectId, value }) {
      const device = devices.get(JSON.stringify([tenantId, deviceId]))
      if (!device) throw new PlatformApiError("DEVICE_NOT_FOUND", 404)
      assertEndpointSubject(device, subjectId, value)
      assertEndpointAcknowledged(device, configuration.desired_state, now(), configuration.stale_after_seconds)
      assertAppliedState(value.applied_state_revision, value.applied_policy_version, configuration.desired_state)
      if (value.route !== "DIRECT") throw new PlatformApiError("ENDPOINT_ROUTE_MISMATCH", 409)
      return {
        policy_rule_id: null,
        resource_id: null,
        route: "DIRECT",
        managed_route: null,
        policy_message: null,
        missing_deployment_capability: null,
      }
    },
  }
}
