import { randomUUID } from "node:crypto"
import { assertCredential, credentialHash, issueCredential, type EndpointCredentialRecord } from "./credentials"
import type { SqlTransaction, SqlAdapter } from "../../persistence/sql-adapter"
import { PlatformApiError } from "../errors"
import type { RegisteredEndpoint, EndpointLifecycleEvent } from "./contract"
import { endpointRuntimeConfiguration, type EndpointRuntimeStore, type EndpointRuntimeStoreOptions } from "./module"
import { assertAppliedState, assertEndpointAcknowledged, assertEndpointSubject } from "./shared"

type Row = Record<string, unknown>

function text(row: Row, name: string): string {
  const value = row[name]
  return typeof value === "string" ? value : String(value ?? "")
}

function nullable(row: Row, name: string): string | null {
  const value = row[name]
  return typeof value === "string" && value ? value : null
}

function integer(row: Row, name: string): number {
  const value = Number(row[name])
  if (!Number.isSafeInteger(value) || value < 0) throw new PlatformApiError("ENDPOINT_RUNTIME_DATA_INVALID", 500)
  return value
}

function mapDevice(row: Row): RegisteredEndpoint {
  const lifecycle = text(row, "lifecycle_state")
  const health = text(row, "health")
  if (
    (lifecycle !== "ACTIVE" && lifecycle !== "REVOKED") ||
    (health !== "UNKNOWN" && health !== "HEALTHY" && health !== "DEGRADED")
  ) throw new PlatformApiError("ENDPOINT_RUNTIME_DATA_INVALID", 500)
  return {
    tenant_id: text(row, "tenant_id"),
    device_id: text(row, "device_id"),
    subject_id: text(row, "subject_id"),
    lifecycle_state: lifecycle,
    enrolled_at: integer(row, "enrolled_at"),
    last_seen_at: integer(row, "last_seen_at"),
    observed_state: {
      endpoint_version: text(row, "endpoint_version"),
      applied_state_revision: nullable(row, "applied_state_revision"),
      applied_policy_version: nullable(row, "applied_policy_version"),
      health,
      reported_at: integer(row, "reported_at"),
    },
    revocation_reason: nullable(row, "revocation_reason"),
  }
}

function mapCredential(row: Row | undefined): EndpointCredentialRecord | undefined {
  if (!row) return undefined
  const kind = text(row, "kind")
  if (kind !== "BOOTSTRAP" && kind !== "RUNTIME") throw new PlatformApiError("ENDPOINT_RUNTIME_DATA_INVALID", 500)
  return { credentialId: text(row, "credential_id"), tenantId: text(row, "tenant_id"), deviceId: text(row, "device_id"),
    subjectId: text(row, "subject_id"), kind, tokenHash: text(row, "token_hash"), expiresAt: integer(row, "expires_at"),
    consumedAt: row.consumed_at === null ? null : integer(row, "consumed_at"),
    revokedAt: row.revoked_at === null ? null : integer(row, "revoked_at") }
}

async function persistCredential(sql: SqlTransaction, row: EndpointCredentialRecord, correlationId: string | null = null) {
  await sql.query(`insert into genio_one_endpoint_credentials
    (credential_id, tenant_id, device_id, subject_id, kind, token_hash, expires_at, correlation_id)
    values ($1,$2,$3,$4,$5,$6,$7,$8)`,
  [row.credentialId, row.tenantId, row.deviceId, row.subjectId, row.kind, row.tokenHash, row.expiresAt, correlationId])
}

export function createPostgresEndpointRuntimeStore(options: {
  sql: SqlAdapter
} & EndpointRuntimeStoreOptions): EndpointRuntimeStore {
  const configuration = endpointRuntimeConfiguration(options)
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  return {
    async bootstrap({ tenantId, subjectId, correlationId }) {
      return options.sql.transaction(async (transaction) => {
        await transaction.query(`select pg_advisory_xact_lock(hashtextextended($1,0))`, [JSON.stringify(["endpoint-bootstrap", tenantId, subjectId, correlationId])])
        const existing = await transaction.query(`select credential_id from genio_one_endpoint_credentials
          where tenant_id = $1 and subject_id = $2 and correlation_id = $3 and kind = 'BOOTSTRAP'`, [tenantId, subjectId, correlationId])
        if (existing.rows.length) throw new PlatformApiError("ENDPOINT_BOOTSTRAP_ALREADY_DELIVERED", 409)
        const deviceId = randomUUID()
        const issued = issueCredential({ tenantId, subjectId, deviceId, kind: "BOOTSTRAP" }, now())
        await persistCredential(transaction, issued.record, correlationId)
        return { tenant_id: tenantId, device_id: deviceId, subject_id: subjectId, credential: issued.credential }
      })
    },
    async authenticateCredential({ tenantId, token }) {
      const result = await options.sql.query<Row>(`select * from genio_one_endpoint_credentials where tenant_id = $1 and token_hash = $2`, [tenantId, credentialHash(token)])
      const record = assertCredential(mapCredential(result.rows[0]), tenantId, now())
      if (record.kind === "RUNTIME") {
        const device = await options.sql.query(`select device_id from genio_one_endpoint_devices where tenant_id = $1 and device_id = $2 and lifecycle_state = 'ACTIVE'`, [tenantId, record.deviceId])
        if (!device.rows.length) throw new PlatformApiError("DEVICE_REVOKED", 403)
      }
      const { tokenHash, consumedAt, revokedAt, ...identity } = record
      return identity
    },
    async rotateCredential({ tenantId, deviceId, credentialId }) {
      return options.sql.transaction(async (transaction) => {
        const device = await transaction.query(`select device_id from genio_one_endpoint_devices where tenant_id = $1 and device_id = $2 and lifecycle_state = 'ACTIVE' for update`, [tenantId, deviceId])
        const result = await transaction.query<Row>(`select * from genio_one_endpoint_credentials where tenant_id = $1 and credential_id = $2 for update`, [tenantId, credentialId])
        const old = assertCredential(mapCredential(result.rows[0]), tenantId, now())
        if (!device.rows.length || old.kind !== "RUNTIME" || old.deviceId !== deviceId) throw new PlatformApiError("ENDPOINT_CREDENTIAL_REJECTED", 401)
        const issued = issueCredential({ tenantId, deviceId, subjectId: old.subjectId, kind: "RUNTIME" }, now())
        await transaction.query(`update genio_one_endpoint_credentials set revoked_at = $2 where credential_id = $1`, [credentialId, now()])
        await persistCredential(transaction, issued.record)
        return issued.credential
      })
    },
    async list({ tenantId }) {
      const result = await options.sql.query<Row>(
        `select * from genio_one_endpoint_devices where tenant_id = $1 order by device_id`, [tenantId])
      return result.rows.map(mapDevice)
    },
    async get({ tenantId, deviceId }) {
      const result = await options.sql.query<Row>(
        `select * from genio_one_endpoint_devices where tenant_id = $1 and device_id = $2`, [tenantId, deviceId])
      if (!result.rows[0]) throw new PlatformApiError("DEVICE_NOT_FOUND", 404)
      return mapDevice(result.rows[0])
    },
    async lifecycleEvents({ tenantId, deviceId }) {
      const device = await options.sql.query<Row>(
        `select device_id from genio_one_endpoint_devices where tenant_id = $1 and device_id = $2`, [tenantId, deviceId])
      if (!device.rows[0]) throw new PlatformApiError("DEVICE_NOT_FOUND", 404)
      const result = await options.sql.query<Row>(
        `select * from genio_one_endpoint_lifecycle_events where tenant_id = $1 and device_id = $2 order by event_id`,
        [tenantId, deviceId])
      return result.rows.map((row): EndpointLifecycleEvent => {
        const kind = text(row, "kind")
        if (kind !== "ENROLLED" && kind !== "REVOKED") throw new PlatformApiError("ENDPOINT_RUNTIME_DATA_INVALID", 500)
        return { tenant_id: tenantId, device_id: deviceId, subject_id: text(row, "subject_id"),
          correlation_id: text(row, "correlation_id"), kind, reason: nullable(row, "reason"), at: integer(row, "at") }
      })
    },
    async revoke({ tenantId, deviceId, subjectId, correlationId, reason }) {
      if (!reason.trim()) throw new PlatformApiError("ENDPOINT_REVOCATION_REASON_REQUIRED", 422)
      return options.sql.transaction(async (transaction) => {
        const result = await transaction.query<Row>(
          `select * from genio_one_endpoint_devices where tenant_id = $1 and device_id = $2 for update`, [tenantId, deviceId])
        if (!result.rows[0]) throw new PlatformApiError("DEVICE_NOT_FOUND", 404)
        const device = mapDevice(result.rows[0])
        if (device.lifecycle_state === "REVOKED") return device
        await transaction.query(`update genio_one_endpoint_credentials set revoked_at = $3 where tenant_id = $1 and device_id = $2 and revoked_at is null`, [tenantId, deviceId, now()])
        const updated = await transaction.query<Row>(
          `update genio_one_endpoint_devices set lifecycle_state = 'REVOKED', revocation_reason = $3
           where tenant_id = $1 and device_id = $2 returning *`, [tenantId, deviceId, reason])
        await transaction.query(
          `insert into genio_one_endpoint_lifecycle_events (tenant_id, device_id, subject_id, correlation_id, kind, reason, at)
           values ($1,$2,$3,$4,'REVOKED',$5,$6)`, [tenantId, deviceId, subjectId, correlationId, reason, now()])
        return mapDevice(updated.rows[0]!)
      })
    },
    async assertApplied({ tenantId, deviceId, subjectId, appliedStateRevision, appliedPolicyVersion }) {
      const result = await options.sql.query<Row>(
        `select * from genio_one_endpoint_devices where tenant_id = $1 and device_id = $2`,
        [tenantId, deviceId],
      )
      if (!result.rows[0]) throw new PlatformApiError("DEVICE_NOT_FOUND", 404)
      const device = mapDevice(result.rows[0])
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
      return options.sql.transaction(async (transaction) => {
        const existing = await transaction.query<Row>(
          `select * from genio_one_endpoint_devices where tenant_id = $1 and device_id = $2 for update`,
          [tenantId, value.device_id],
        )
        const credentialResult = await transaction.query<Row>(`select * from genio_one_endpoint_credentials where tenant_id = $1 and credential_id = $2 for update`, [tenantId, credentialId])
        const credential = assertCredential(mapCredential(credentialResult.rows[0]), tenantId, now())
        if (credential.subjectId !== subjectId || credential.deviceId !== value.device_id) throw new PlatformApiError("ENDPOINT_CREDENTIAL_REJECTED", 401)
        if (existing.rows[0]) {
          const device = mapDevice(existing.rows[0])
          if (device.subject_id !== subjectId) throw new PlatformApiError("DEVICE_ALREADY_REGISTERED", 409)
          if (device.lifecycle_state === "REVOKED") throw new PlatformApiError("DEVICE_REVOKED", 403)
          if (credential.kind !== "RUNTIME") throw new PlatformApiError("ENDPOINT_CREDENTIAL_REJECTED", 401)
          return { device, runtime_credential: null, configuration }
        }
        if (credential.kind !== "BOOTSTRAP") throw new PlatformApiError("ENDPOINT_CREDENTIAL_REJECTED", 401)
        const at = now()
        const inserted = await transaction.query<Row>(
          `insert into genio_one_endpoint_devices (
             tenant_id, device_id, subject_id, lifecycle_state, enrolled_at,
             last_seen_at, endpoint_version, applied_state_revision,
             applied_policy_version, health, reported_at, revocation_reason
           ) values ($1,$2,$3,'ACTIVE',$4,$4,$5,null,null,'UNKNOWN',$4,null)
           returning *`,
          [tenantId, value.device_id, subjectId, at, value.endpoint_version],
        )
        await transaction.query(
          `insert into genio_one_endpoint_lifecycle_events (tenant_id, device_id, subject_id, correlation_id, kind, reason, at)
           values ($1,$2,$3,$4,'ENROLLED',null,$5)`, [tenantId, value.device_id, subjectId, value.correlation_id, at])
        const issued = issueCredential({ tenantId, deviceId: value.device_id, subjectId, kind: "RUNTIME" }, at)
        await transaction.query(`update genio_one_endpoint_credentials set consumed_at = $2 where credential_id = $1`, [credentialId, at])
        await persistCredential(transaction, issued.record)
        return { device: mapDevice(inserted.rows[0]!), runtime_credential: issued.credential, configuration }
      })
    },
    async heartbeat({ tenantId, deviceId, subjectId, value }) {
      if (Boolean(value.applied_state_revision) !== Boolean(value.applied_policy_version)) {
        throw new PlatformApiError("ENDPOINT_OBSERVATION_INVALID", 422)
      }
      return options.sql.transaction(async (transaction) => {
        const existing = await transaction.query<Row>(
          `select * from genio_one_endpoint_devices where tenant_id = $1 and device_id = $2 for update`,
          [tenantId, deviceId],
        )
        if (!existing.rows[0]) throw new PlatformApiError("DEVICE_NOT_FOUND", 404)
        const device = mapDevice(existing.rows[0])
        assertEndpointSubject(device, subjectId, value)
        const at = now()
        const updated = await transaction.query<Row>(
          `update genio_one_endpoint_devices
              set last_seen_at = $3,
                  endpoint_version = $4,
                  applied_state_revision = $5,
                  applied_policy_version = $6,
                  health = $7,
                  reported_at = $3
            where tenant_id = $1 and device_id = $2
            returning *`,
          [
            tenantId,
            deviceId,
            at,
            value.endpoint_version,
            value.applied_state_revision,
            value.applied_policy_version,
            value.health,
          ],
        )
        const applied = value.applied_state_revision === configuration.desired_state.revision &&
          value.applied_policy_version === configuration.desired_state.policy_version
        return {
          device: mapDevice(updated.rows[0]!),
          desired_state: applied ? null : configuration.desired_state,
        }
      })
    },
    async enforce({ tenantId, deviceId, subjectId, value }) {
      const result = await options.sql.query<Row>(
        `select * from genio_one_endpoint_devices where tenant_id = $1 and device_id = $2`,
        [tenantId, deviceId],
      )
      if (!result.rows[0]) throw new PlatformApiError("DEVICE_NOT_FOUND", 404)
      const device = mapDevice(result.rows[0])
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
