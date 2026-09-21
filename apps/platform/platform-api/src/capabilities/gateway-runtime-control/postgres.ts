import { randomUUID } from "node:crypto"

import { Check } from "typebox/value"

import type { SqlAdapter, SqlTransaction } from "../../persistence/sql-adapter"
import { PlatformApiError } from "../errors"
import type { GatewayProjectionSigner } from "../gateway-projection/contract"
import {
  GatewayReleaseReferenceSchema,
  parseGatewayObservedState,
  parseGatewayRuntimeCommand,
  parseGatewayRuntimeReport,
  type GatewayObservedState,
  type GatewayRuntimeCommand,
  type GatewayRuntimeReport,
} from "@genioone/protocol/gateway-release"
import type {
  RuntimeRegistration,
  RuntimeRegistrationKey,
} from "../runtime-control/contract"
import {
  gatewayReleaseReferencesEqual,
  signGatewayReleaseCommand,
  verifyGatewayReleaseReport,
  verifyRuntimeMessage,
} from "../runtime-control/gateway-release-integrity"
import { lockRuntimeTopology } from "../runtime-control/runtime-topology-lock"
import {
  GatewayAggregateCommandRecordSchema,
  GatewayAggregateObservedStateRecordSchema,
  GatewayAggregateReportHistoryRecordSchema,
  GatewayAggregateRuntimeGroupSchema,
  GatewayRuntimeCapabilitiesSchema,
  RuntimeProtocolVersionSchema,
  supportsGatewayAggregateDelivery,
  type EnqueueGatewayReleaseInput,
  type GatewayAggregateCommandRecord,
  type GatewayAggregateDeliveryMode,
  type GatewayAggregateObservedStateRecord,
  type GatewayAggregateReportHistoryRecord,
  type GatewayAggregateReportResult,
  type GatewayAggregateRuntimeControlStore,
  type GatewayAggregateRuntimeSelector,
  type GatewayAggregateRuntimeGroup,
  type GatewayRuntimeCapabilities,
  type RuntimeProtocolVersion,
  type SaveGatewayRuntimeCapabilitiesInput,
} from "./contract"

type DatabaseRow = Record<string, unknown>

export interface PostgresGatewayAggregateRuntimeControlStoreOptions {
  sql: SqlAdapter
  signer?: GatewayProjectionSigner
  /** Optional public key for verifying commands read back from PostgreSQL. */
  commandPublicKeyPem?: string
  now?: () => number
  idFactory?: (prefix: string) => string
}

export interface PostgresGatewayAggregateRuntimeControlStore
  extends GatewayAggregateRuntimeControlStore, GatewayAggregateRuntimeSelector {}

const RUNTIME_REGISTRATION_COLUMNS = `
  tenant_id,
  runtime_kind,
  runtime_id,
  target_id,
  oidc_client_id,
  report_key_id,
  report_public_key_pem,
  status,
  row_revision,
  extract(epoch from created_at)::bigint as created_at,
  extract(epoch from updated_at)::bigint as updated_at`

const CAPABILITY_COLUMNS = `
  tenant_id,
  runtime_kind,
  runtime_id,
  protocol_versions,
  preferred_protocol_version,
  delivery_mode,
  row_revision,
  extract(epoch from created_at)::bigint as created_at,
  extract(epoch from updated_at)::bigint as updated_at`

const PILOT_RUNTIME_COLUMNS = `
  runtime_registration.tenant_id as tenant_id,
  runtime_registration.runtime_kind as runtime_kind,
  runtime_registration.runtime_id as runtime_id,
  runtime_registration.target_id as target_id,
  runtime_capability.protocol_versions as protocol_versions,
  runtime_capability.preferred_protocol_version as preferred_protocol_version,
  runtime_capability.delivery_mode as delivery_mode`

const COMMAND_COLUMNS = `
  tenant_id,
  runtime_kind,
  runtime_id,
  command_id,
  release_id,
  gateway_id,
  head_revision,
  package_digest,
  projection_count,
  command,
  state,
  failure_code,
  failure_message,
  extract(epoch from created_at)::bigint as created_at,
  extract(epoch from delivered_at)::bigint as delivered_at,
  extract(epoch from acknowledged_at)::bigint as acknowledged_at,
  extract(epoch from failed_at)::bigint as failed_at,
  extract(epoch from updated_at)::bigint as updated_at`

const OBSERVED_COLUMNS = `
  tenant_id,
  runtime_kind,
  runtime_id,
  command_id,
  report_id,
  revision,
  digest,
  applied_release,
  observed_status,
  extract(epoch from observed_at)::bigint as observed_at,
  extract(epoch from updated_at)::bigint as updated_at`

const REPORT_COLUMNS = `
  tenant_id,
  runtime_kind,
  runtime_id,
  report_id,
  command_id,
  release_id,
  package_digest,
  revision,
  digest,
  report,
  outcome,
  extract(epoch from observed_at)::bigint as observed_at`

function runtimeIdentifier(value: string, code: string): void {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new PlatformApiError(code, 422, `${code} is invalid`)
  }
}

function jsonValue(value: unknown, code: string): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new PlatformApiError(code, 500, "Persisted runtime JSON is invalid")
  }
}

function rowString(row: DatabaseRow, key: string, code = "RUNTIME_AGGREGATE_DATA_INVALID"): string {
  const value = row[key]
  if (typeof value !== "string" || !value.trim()) {
    throw new PlatformApiError(code, 500)
  }
  return value
}

function rowOptionalString(row: DatabaseRow, key: string): string | null {
  const value = row[key]
  if (value === null || value === undefined) return null
  if (typeof value !== "string" || !value.trim()) {
    throw new PlatformApiError("RUNTIME_AGGREGATE_DATA_INVALID", 500)
  }
  return value
}

function rowInteger(
  row: DatabaseRow,
  key: string,
  minimum: number,
  code = "RUNTIME_AGGREGATE_DATA_INVALID",
): number {
  const value = row[key]
  const parsed =
    typeof value === "bigint" ? Number(value) :
      typeof value === "number" ? value :
        typeof value === "string" ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new PlatformApiError(code, 500)
  }
  return parsed
}

function rowTimestamp(row: DatabaseRow, key: string, fallback: number): number {
  const value = row[key]
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return Math.floor(value.getTime() / 1000)
  }
  if (typeof value === "bigint") return Number(value)
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value)
  if (typeof value === "string") {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return Math.floor(numeric)
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000)
  }
  return fallback
}

function rowNullableTimestamp(row: DatabaseRow, key: string, fallback: number): number | null {
  if (row[key] === null || row[key] === undefined) return null
  return rowTimestamp(row, key, fallback)
}

function runtimeStatus(value: unknown): RuntimeRegistration["status"] {
  if (value === "ACTIVE" || value === "DISABLED" || value === "REVOKED") return value
  throw new PlatformApiError("RUNTIME_REGISTRATION_DATA_INVALID", 500)
}

function mapRegistration(row: DatabaseRow, now: () => number): RuntimeRegistration {
  if (rowString(row, "runtime_kind", "RUNTIME_REGISTRATION_DATA_INVALID") !== "GATEWAY") {
    throw new PlatformApiError("RUNTIME_REGISTRATION_DATA_INVALID", 500)
  }
  return {
    tenant_id: rowString(row, "tenant_id", "RUNTIME_REGISTRATION_DATA_INVALID"),
    runtime_kind: "GATEWAY",
    runtime_id: rowString(row, "runtime_id", "RUNTIME_REGISTRATION_DATA_INVALID"),
    target_id: rowString(row, "target_id", "RUNTIME_REGISTRATION_DATA_INVALID"),
    oidc_client_id: rowString(row, "oidc_client_id", "RUNTIME_REGISTRATION_DATA_INVALID"),
    report_key_id: rowString(row, "report_key_id", "RUNTIME_REGISTRATION_DATA_INVALID"),
    report_public_key_pem: rowString(
      row,
      "report_public_key_pem",
      "RUNTIME_REGISTRATION_DATA_INVALID",
    ),
    status: runtimeStatus(row.status),
    row_revision: rowInteger(row, "row_revision", 1, "RUNTIME_REGISTRATION_DATA_INVALID"),
    created_at: rowTimestamp(row, "created_at", now()),
    updated_at: rowTimestamp(row, "updated_at", now()),
  }
}

function parseProtocolVersions(value: unknown): RuntimeProtocolVersion[] {
  const parsed = jsonValue(value, "RUNTIME_CAPABILITIES_DATA_INVALID")
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 1 ||
    parsed.some((item) => !Check(RuntimeProtocolVersionSchema, item)) ||
    new Set(parsed).size !== parsed.length
  ) {
    throw new PlatformApiError("RUNTIME_CAPABILITIES_DATA_INVALID", 500)
  }
  const normalized = [...parsed].sort() as RuntimeProtocolVersion[]
  if (parsed.some((item, index) => item !== normalized[index])) {
    throw new PlatformApiError("RUNTIME_CAPABILITIES_DATA_INVALID", 500)
  }
  return normalized
}

function rowIdentifier(
  row: DatabaseRow,
  key: string,
  code = "RUNTIME_RUNTIME_SELECTION_DATA_INVALID",
): string {
  const value = rowString(row, key, code)
  if (value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new PlatformApiError(code, 500)
  }
  return value
}

function mapGatewayRuntimeReplica(
  row: DatabaseRow,
  tenantId: string,
  gatewayId: string,
): string {
  const rowTenantId = rowIdentifier(row, "tenant_id")
  const runtimeKind = rowIdentifier(row, "runtime_kind")
  const runtimeId = rowIdentifier(row, "runtime_id")
  const targetId = rowIdentifier(row, "target_id")
  const protocolVersions = parseProtocolVersions(row.protocol_versions)
  const preferredProtocolVersion = rowIdentifier(row, "preferred_protocol_version")
  const deliveryMode = rowIdentifier(row, "delivery_mode")

  if (
    rowTenantId !== tenantId ||
    runtimeKind !== "GATEWAY" ||
    targetId !== gatewayId ||
    !supportsGatewayAggregateDelivery({
      protocolVersions,
      preferredProtocolVersion,
      deliveryMode,
    })
  ) {
    throw new PlatformApiError("RUNTIME_RUNTIME_SELECTION_DATA_INVALID", 500)
  }

  return runtimeId
}

function validateCapability(
  value: GatewayRuntimeCapabilities,
  errorCode = "RUNTIME_CAPABILITIES_DATA_INVALID",
): GatewayRuntimeCapabilities {
  if (
    !Check(GatewayRuntimeCapabilitiesSchema, value) ||
    value.runtime_kind !== "GATEWAY" ||
    !supportsGatewayAggregateDelivery({
      protocolVersions: value.protocol_versions,
      preferredProtocolVersion: value.preferred_protocol_version,
      deliveryMode: value.delivery_mode,
    }) ||
    value.protocol_versions.some((item, index) =>
      index > 0 && item <= value.protocol_versions[index - 1])
  ) {
    throw new PlatformApiError(errorCode, 500)
  }
  return value
}

function mapCapabilities(row: DatabaseRow, now: () => number): GatewayRuntimeCapabilities {
  const value: GatewayRuntimeCapabilities = {
    tenant_id: rowString(row, "tenant_id"),
    runtime_kind: "GATEWAY",
    runtime_id: rowString(row, "runtime_id"),
    protocol_versions: parseProtocolVersions(row.protocol_versions),
    preferred_protocol_version: rowString(row, "preferred_protocol_version") as RuntimeProtocolVersion,
    delivery_mode: rowString(row, "delivery_mode") as GatewayAggregateDeliveryMode,
    row_revision: rowInteger(row, "row_revision", 1),
    created_at: rowTimestamp(row, "created_at", now()),
    updated_at: rowTimestamp(row, "updated_at", now()),
  }
  return validateCapability(value)
}

function digest(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new PlatformApiError("RUNTIME_AGGREGATE_DATA_INVALID", 500)
  }
}

function mapCommand(
  row: DatabaseRow,
  now: () => number,
  commandPublicKeyPem?: string,
  commandKeyId?: string,
): GatewayAggregateCommandRecord {
  const commandValue = jsonValue(row.command, "RUNTIME_COMMAND_DATA_INVALID")
  let command: GatewayRuntimeCommand
  try {
    command = parseGatewayRuntimeCommand(commandValue)
  } catch {
    throw new PlatformApiError("RUNTIME_COMMAND_DATA_INVALID", 500)
  }
  if (command.runtime_kind !== "GATEWAY") {
    throw new PlatformApiError("RUNTIME_COMMAND_DATA_INVALID", 500)
  }
  if (commandPublicKeyPem !== undefined) {
    try {
      verifyRuntimeMessage({
        message: command,
        publicKeyPem: commandPublicKeyPem,
        expectedKeyId: commandKeyId ?? command.signature.key_id,
      })
    } catch {
      throw new PlatformApiError("RUNTIME_COMMAND_DATA_INVALID", 500)
    }
  }
  const release = command.desired_release
  const tenantId = rowString(row, "tenant_id", "RUNTIME_COMMAND_DATA_INVALID")
  const runtimeId = rowString(row, "runtime_id", "RUNTIME_COMMAND_DATA_INVALID")
  const commandId = rowString(row, "command_id", "RUNTIME_COMMAND_DATA_INVALID")
  const releaseId = rowString(row, "release_id", "RUNTIME_COMMAND_DATA_INVALID")
  const gatewayId = rowString(row, "gateway_id", "RUNTIME_COMMAND_DATA_INVALID")
  const headRevision = rowInteger(row, "head_revision", 1, "RUNTIME_COMMAND_DATA_INVALID")
  const packageDigest = rowString(row, "package_digest", "RUNTIME_COMMAND_DATA_INVALID")
  digest(packageDigest)
  const projectionCount = rowInteger(row, "projection_count", 0, "RUNTIME_COMMAND_DATA_INVALID")
  if (
    command.tenant_id !== tenantId ||
    command.runtime_id !== runtimeId ||
    command.command_id !== commandId ||
    command.revision !== String(headRevision) ||
    release.release_id !== releaseId ||
    release.gateway_id !== gatewayId ||
    release.head_revision !== headRevision ||
    release.package_digest !== packageDigest ||
    release.projection_count !== projectionCount
  ) {
    throw new PlatformApiError("RUNTIME_COMMAND_DATA_INVALID", 500)
  }
  const value: GatewayAggregateCommandRecord = {
    tenant_id: tenantId,
    runtime_kind: "GATEWAY",
    runtime_id: runtimeId,
    command_id: commandId,
    release_id: releaseId,
    gateway_id: gatewayId,
    head_revision: headRevision,
    package_digest: packageDigest,
    projection_count: projectionCount,
    command,
    state: rowString(row, "state", "RUNTIME_COMMAND_DATA_INVALID") as GatewayAggregateCommandRecord["state"],
    failure_code: rowOptionalString(row, "failure_code"),
    failure_message: rowOptionalString(row, "failure_message"),
    created_at: rowTimestamp(row, "created_at", now()),
    delivered_at: rowNullableTimestamp(row, "delivered_at", now()),
    acknowledged_at: rowNullableTimestamp(row, "acknowledged_at", now()),
    failed_at: rowNullableTimestamp(row, "failed_at", now()),
    updated_at: rowTimestamp(row, "updated_at", now()),
  }
  if (!Check(GatewayAggregateCommandRecordSchema, value) ||
    (value.state !== "PENDING" && value.state !== "ACKNOWLEDGED" && value.state !== "FAILED")) {
    throw new PlatformApiError("RUNTIME_COMMAND_DATA_INVALID", 500)
  }
  return value
}

function observedStatus(value: unknown, revision: string): GatewayObservedState {
  const parsed = jsonValue(value, "RUNTIME_OBSERVED_STATE_INVALID")
  try {
    return parseGatewayObservedState(parsed, revision)
  } catch {
    throw new PlatformApiError("RUNTIME_OBSERVED_STATE_INVALID", 500)
  }
}

function mapObserved(row: DatabaseRow, now: () => number): GatewayAggregateObservedStateRecord {
  const appliedValue = jsonValue(row.applied_release, "RUNTIME_OBSERVED_STATE_INVALID")
  const appliedRelease = appliedValue === null || appliedValue === undefined
    ? null
    : appliedValue
  if (appliedRelease !== null && !Check(GatewayReleaseReferenceSchema, appliedRelease)) {
    throw new PlatformApiError("RUNTIME_OBSERVED_STATE_INVALID", 500)
  }
  const revision = rowString(row, "revision", "RUNTIME_OBSERVED_STATE_INVALID")
  if (!/^\d+$/.test(revision) ||
    !Number.isSafeInteger(Number(revision)) ||
    Number(revision) < 1) {
    throw new PlatformApiError("RUNTIME_OBSERVED_STATE_INVALID", 500)
  }
  const value: GatewayAggregateObservedStateRecord = {
    tenant_id: rowString(row, "tenant_id", "RUNTIME_OBSERVED_STATE_INVALID"),
    runtime_kind: "GATEWAY",
    runtime_id: rowString(row, "runtime_id", "RUNTIME_OBSERVED_STATE_INVALID"),
    command_id: rowString(row, "command_id", "RUNTIME_OBSERVED_STATE_INVALID"),
    report_id: rowString(row, "report_id", "RUNTIME_OBSERVED_STATE_INVALID"),
    revision,
    digest: rowString(row, "digest", "RUNTIME_OBSERVED_STATE_INVALID"),
    applied_release: appliedRelease as GatewayAggregateObservedStateRecord["applied_release"],
    observed_status: observedStatus(row.observed_status, revision),
    observed_at: rowTimestamp(row, "observed_at", now()),
    updated_at: rowTimestamp(row, "updated_at", now()),
  }
  digest(value.digest)
  if (
    (value.observed_status.applied_release !== undefined &&
      (value.applied_release === null ||
        !gatewayReleaseReferencesEqual(
          value.observed_status.applied_release,
          value.applied_release,
        ))) ||
    !Check(GatewayAggregateObservedStateRecordSchema, value)
  ) {
    throw new PlatformApiError("RUNTIME_OBSERVED_STATE_INVALID", 500)
  }
  return value
}

function mapHistory(row: DatabaseRow): GatewayAggregateReportHistoryRecord {
  let report: GatewayRuntimeReport
  try {
    report = parseGatewayRuntimeReport(jsonValue(row.report, "RUNTIME_REPORT_DATA_INVALID"))
  } catch {
    throw new PlatformApiError("RUNTIME_REPORT_DATA_INVALID", 500)
  }
  const tenantId = rowString(row, "tenant_id", "RUNTIME_REPORT_DATA_INVALID")
  const runtimeId = rowString(row, "runtime_id", "RUNTIME_REPORT_DATA_INVALID")
  const reportId = rowString(row, "report_id", "RUNTIME_REPORT_DATA_INVALID")
  const commandId = rowString(row, "command_id", "RUNTIME_REPORT_DATA_INVALID")
  const releaseId = rowString(row, "release_id", "RUNTIME_REPORT_DATA_INVALID")
  const packageDigest = rowString(row, "package_digest", "RUNTIME_REPORT_DATA_INVALID")
  const revision = rowString(row, "revision", "RUNTIME_REPORT_DATA_INVALID")
  const reportDigest = rowString(row, "digest", "RUNTIME_REPORT_DATA_INVALID")
  const outcome = rowString(row, "outcome", "RUNTIME_REPORT_DATA_INVALID")
  digest(packageDigest)
  digest(reportDigest)
  if (
    report.tenant_id !== tenantId ||
    report.runtime_id !== runtimeId ||
    report.report_id !== reportId ||
    report.command_id !== commandId ||
    report.revision !== revision ||
    report.digest !== reportDigest ||
    !/^\d+$/.test(revision) ||
    !Number.isSafeInteger(Number(revision)) ||
    Number(revision) < 1 ||
    (outcome !== "ACCEPTED" && outcome !== "STALE")
  ) {
    throw new PlatformApiError("RUNTIME_REPORT_DATA_INVALID", 500)
  }
  const value: GatewayAggregateReportHistoryRecord = {
    tenant_id: tenantId,
    runtime_kind: "GATEWAY",
    runtime_id: runtimeId,
    report_id: reportId,
    command_id: commandId,
    release_id: releaseId,
    package_digest: packageDigest,
    revision,
    digest: reportDigest,
    report,
    outcome,
    observed_at: rowTimestamp(row, "observed_at", 0),
  }
  if (!Check(GatewayAggregateReportHistoryRecordSchema, value)) {
    throw new PlatformApiError("RUNTIME_REPORT_DATA_INVALID", 500)
  }
  return value
}

async function selectRegistration(
  executor: SqlAdapter | SqlTransaction,
  tenantId: string,
  runtimeId: string,
  forUpdate = false,
): Promise<DatabaseRow | null> {
  const result = await executor.query<DatabaseRow>(
    `select ${RUNTIME_REGISTRATION_COLUMNS}
       from genio_one_platform_runtime_registrations
      where tenant_id = $1 and runtime_kind = 'GATEWAY' and runtime_id = $2${forUpdate ? " for update" : ""}`,
    [tenantId, runtimeId],
  )
  return result.rows[0] ?? null
}

async function requireActiveRuntime(
  executor: SqlAdapter | SqlTransaction,
  tenantId: string,
  runtimeId: string,
  now: () => number,
  forUpdate = false,
): Promise<RuntimeRegistration> {
  const row = await selectRegistration(executor, tenantId, runtimeId, forUpdate)
  if (!row) throw new PlatformApiError("RUNTIME_RUNTIME_NOT_REGISTERED", 404)
  const registration = mapRegistration(row, now)
  if (registration.status !== "ACTIVE") {
    throw new PlatformApiError("RUNTIME_RUNTIME_NOT_ACTIVE", 403)
  }
  return registration
}

async function selectCapability(
  executor: SqlAdapter | SqlTransaction,
  tenantId: string,
  runtimeId: string,
  forUpdate = false,
): Promise<DatabaseRow | null> {
  const result = await executor.query<DatabaseRow>(
    `select ${CAPABILITY_COLUMNS}
       from genio_one_platform_runtime_capabilities
      where tenant_id = $1 and runtime_kind = 'GATEWAY' and runtime_id = $2${forUpdate ? " for update" : ""}`,
    [tenantId, runtimeId],
  )
  return result.rows[0] ?? null
}

async function selectGatewayGroupInTransaction(input: {
  transaction: SqlTransaction
  tenantId: string
  gatewayId: string
}): Promise<GatewayAggregateRuntimeGroup> {
  runtimeIdentifier(input.tenantId, "TENANT_REQUIRED")
  runtimeIdentifier(input.gatewayId, "RUNTIME_TARGET_REQUIRED")
  await lockRuntimeTopology({ transaction: input.transaction, tenantId: input.tenantId })

  const result = await input.transaction.query<DatabaseRow>(
    `select ${PILOT_RUNTIME_COLUMNS}
       from genio_one_platform_runtime_registrations runtime_registration
       join genio_one_platform_runtime_capabilities runtime_capability
         on runtime_capability.tenant_id = runtime_registration.tenant_id
        and runtime_capability.runtime_kind = runtime_registration.runtime_kind
        and runtime_capability.runtime_id = runtime_registration.runtime_id
      where runtime_registration.tenant_id = $1
        and runtime_registration.runtime_kind = 'GATEWAY'
        and runtime_registration.target_id = $2
        and runtime_registration.status = 'ACTIVE'
        and runtime_capability.protocol_versions @> '["genio.one.runtime.v1"]'::jsonb
        and runtime_capability.preferred_protocol_version = 'genio.one.runtime.v1'
        and runtime_capability.delivery_mode = 'AGGREGATE_RELEASE'
      order by runtime_registration.runtime_id
      for update of runtime_registration, runtime_capability`,
    [input.tenantId, input.gatewayId],
  )

  if (result.rows.length === 0) {
    const registered = await input.transaction.query<DatabaseRow>(
      `select runtime_id
         from genio_one_platform_runtime_registrations
        where tenant_id = $1
          and runtime_kind = 'GATEWAY'
          and target_id = $2
        for update`,
      [input.tenantId, input.gatewayId],
    )
    if (registered.rows.length > 0) {
      throw new PlatformApiError(
        "GATEWAY_RUNTIME_NOT_ELIGIBLE",
        409,
        `No active aggregate Gateway runtime is eligible for target ${input.gatewayId}`,
      )
    }
    throw new PlatformApiError(
      "GATEWAY_RUNTIME_NOT_REGISTERED",
      409,
      `No eligible aggregate Gateway runtime is registered for target ${input.gatewayId}`,
    )
  }
  const group: GatewayAggregateRuntimeGroup = {
    tenant_id: input.tenantId,
    gateway_id: input.gatewayId,
    runtime_ids: result.rows
      .map((row) => mapGatewayRuntimeReplica(row, input.tenantId, input.gatewayId))
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
  }
  if (!Check(GatewayAggregateRuntimeGroupSchema, group)) {
    throw new PlatformApiError("RUNTIME_RUNTIME_SELECTION_DATA_INVALID", 500)
  }
  return group
}

async function selectCommand(
  executor: SqlAdapter | SqlTransaction,
  input: RuntimeRegistrationKey & { commandId: string },
  forUpdate = false,
): Promise<DatabaseRow | null> {
  const result = await executor.query<DatabaseRow>(
    `select ${COMMAND_COLUMNS}
       from genio_one_platform_runtime_aggregate_commands
      where tenant_id = $1 and runtime_kind = 'GATEWAY'
        and runtime_id = $2 and command_id = $3${forUpdate ? " for update" : ""}`,
    [input.tenantId, input.runtimeId, input.commandId],
  )
  return result.rows[0] ?? null
}

async function selectCommandByRelease(
  executor: SqlAdapter | SqlTransaction,
  tenantId: string,
  runtimeId: string,
  releaseId: string,
  forUpdate = false,
): Promise<DatabaseRow | null> {
  const result = await executor.query<DatabaseRow>(
    `select ${COMMAND_COLUMNS}
       from genio_one_platform_runtime_aggregate_commands
      where tenant_id = $1 and runtime_kind = 'GATEWAY'
        and runtime_id = $2 and release_id = $3${forUpdate ? " for update" : ""}`,
    [tenantId, runtimeId, releaseId],
  )
  return result.rows[0] ?? null
}

async function selectObserved(
  executor: SqlAdapter | SqlTransaction,
  tenantId: string,
  runtimeId: string,
  forUpdate = false,
): Promise<DatabaseRow | null> {
  const result = await executor.query<DatabaseRow>(
    `select ${OBSERVED_COLUMNS}
       from genio_one_platform_runtime_aggregate_observed_states
      where tenant_id = $1 and runtime_kind = 'GATEWAY' and runtime_id = $2${forUpdate ? " for update" : ""}`,
    [tenantId, runtimeId],
  )
  return result.rows[0] ?? null
}

async function selectHistory(
  executor: SqlAdapter | SqlTransaction,
  tenantId: string,
  runtimeId: string,
  reportId: string,
  forUpdate = false,
): Promise<DatabaseRow | null> {
  const result = await executor.query<DatabaseRow>(
    `select ${REPORT_COLUMNS}
       from genio_one_platform_runtime_aggregate_report_history
      where tenant_id = $1 and runtime_kind = 'GATEWAY'
        and runtime_id = $2 and report_id = $3${forUpdate ? " for update" : ""}`,
    [tenantId, runtimeId, reportId],
  )
  return result.rows[0] ?? null
}

function compareRevision(left: string, right: string): number {
  const leftNumber = Number(left)
  const rightNumber = Number(right)
  if (!Number.isSafeInteger(leftNumber) || !Number.isSafeInteger(rightNumber)) {
    throw new PlatformApiError("RUNTIME_AGGREGATE_REVISION_INVALID", 500)
  }
  return leftNumber - rightNumber
}

function commandPublicKey(options: PostgresGatewayAggregateRuntimeControlStoreOptions): string | undefined {
  if (options.commandPublicKeyPem !== undefined) return options.commandPublicKeyPem
  const signer = options.signer as (GatewayProjectionSigner & { publicKeyPem?: unknown }) | undefined
  return typeof signer?.publicKeyPem === "string" ? signer.publicKeyPem : undefined
}

function capabilityMatches(
  current: GatewayRuntimeCapabilities,
  input: SaveGatewayRuntimeCapabilitiesInput,
  versions: RuntimeProtocolVersion[],
): boolean {
  return current.protocol_versions.length === versions.length &&
    current.protocol_versions.every((value, index) => value === versions[index]) &&
    current.preferred_protocol_version === input.preferredProtocolVersion &&
    current.delivery_mode === input.deliveryMode
}

function validateCapabilityInput(input: SaveGatewayRuntimeCapabilitiesInput): RuntimeProtocolVersion[] {
  runtimeIdentifier(input.tenantId, "TENANT_REQUIRED")
  runtimeIdentifier(input.runtimeId, "RUNTIME_ID_REQUIRED")
  const versions = [...input.protocolVersions]
  if (
    new Set(versions).size !== versions.length ||
    !versions.includes(input.preferredProtocolVersion) ||
    !supportsGatewayAggregateDelivery({
      protocolVersions: versions,
      preferredProtocolVersion: input.preferredProtocolVersion,
      deliveryMode: input.deliveryMode,
    })
  ) {
    throw new PlatformApiError("RUNTIME_CAPABILITIES_INVALID", 422)
  }
  return versions.sort()
}

function releaseReference(value: unknown) {
  if (!Check(GatewayReleaseReferenceSchema, value)) {
    throw new PlatformApiError("RUNTIME_RELEASE_REFERENCE_INVALID", 422)
  }
  return value as GatewayAggregateCommandRecord["command"]["desired_release"]
}

export function createPostgresGatewayAggregateRuntimeControlStore(
  options: PostgresGatewayAggregateRuntimeControlStoreOptions,
): PostgresGatewayAggregateRuntimeControlStore {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const idFactory = options.idFactory ?? ((prefix: string) => `${prefix}-${randomUUID()}`)
  const publicKey = commandPublicKey(options)

  const enqueue = async (
    input: EnqueueGatewayReleaseInput,
  ): Promise<GatewayAggregateCommandRecord> => {
    runtimeIdentifier(input.tenantId, "TENANT_REQUIRED")
    runtimeIdentifier(input.runtimeId, "RUNTIME_ID_REQUIRED")
    const release = releaseReference(input.release)
    if (!options.signer) {
      throw new PlatformApiError(
        "RUNTIME_COMMAND_SIGNER_REQUIRED",
        500,
        "A durable runtime command signer is required",
      )
    }
    const signer = options.signer
    const work = async (transaction: SqlTransaction): Promise<GatewayAggregateCommandRecord> => {
      const registration = await requireActiveRuntime(
        transaction,
        input.tenantId,
        input.runtimeId,
        now,
        true,
      )
      if (registration.target_id !== release.gateway_id) {
        throw new PlatformApiError("RUNTIME_RELEASE_TARGET_MISMATCH", 409)
      }
      const capabilityRow = await selectCapability(
        transaction,
        input.tenantId,
        input.runtimeId,
        true,
      )
      if (!capabilityRow) {
        throw new PlatformApiError("RUNTIME_AGGREGATE_DELIVERY_UNSUPPORTED", 409)
      }
      try {
        validateCapability(mapCapabilities(capabilityRow, now), "RUNTIME_AGGREGATE_DELIVERY_UNSUPPORTED")
      } catch (error) {
        if (error instanceof PlatformApiError && error.code === "RUNTIME_CAPABILITIES_DATA_INVALID") {
          throw new PlatformApiError("RUNTIME_AGGREGATE_DELIVERY_UNSUPPORTED", 409)
        }
        throw error
      }

      const existingRow = await selectCommandByRelease(
        transaction,
        input.tenantId,
        input.runtimeId,
        release.release_id,
        true,
      )
      if (existingRow) {
        const existing = mapCommand(existingRow, now, publicKey, signer.keyId)
        if (!gatewayReleaseReferencesEqual(existing.command.desired_release, release)) {
          throw new PlatformApiError("RUNTIME_AGGREGATE_COMMAND_IMMUTABLE", 409)
        }
        return existing
      }

      const command = await signGatewayReleaseCommand({
        tenantId: input.tenantId,
        runtimeId: input.runtimeId,
        release,
        signer,
        commandId: idFactory("gateway-release-command"),
      })
      try {
        if (publicKey !== undefined) {
          verifyRuntimeMessage({
            message: command,
            publicKeyPem: publicKey,
            expectedKeyId: signer.keyId,
          })
        }
      } catch (error) {
        if (error instanceof PlatformApiError) throw error
        throw new PlatformApiError("RUNTIME_COMMAND_SIGNING_INVALID", 500)
      }

      const inserted = await transaction.query<DatabaseRow>(
        `insert into genio_one_platform_runtime_aggregate_commands
           (tenant_id, runtime_kind, runtime_id, command_id, release_id,
            gateway_id, head_revision, package_digest, projection_count,
            command, state)
         values ($1, 'GATEWAY', $2, $3, $4, $5, $6, $7, $8, $9::text::jsonb, 'PENDING')
         on conflict (tenant_id, runtime_kind, runtime_id, release_id) do nothing
         returning ${COMMAND_COLUMNS}`,
        [
          input.tenantId,
          input.runtimeId,
          command.command_id,
          release.release_id,
          release.gateway_id,
          release.head_revision,
          release.package_digest,
          release.projection_count,
          JSON.stringify(command),
        ],
      )
      if (inserted.rows[0]) return mapCommand(inserted.rows[0], now, publicKey, signer.keyId)
      const raced = await selectCommandByRelease(
        transaction,
        input.tenantId,
        input.runtimeId,
        release.release_id,
        true,
      )
      if (!raced) throw new PlatformApiError("RUNTIME_AGGREGATE_COMMAND_WRITE_RACE", 500)
      const existing = mapCommand(raced, now, publicKey, signer.keyId)
      if (!gatewayReleaseReferencesEqual(existing.command.desired_release, release)) {
        throw new PlatformApiError("RUNTIME_AGGREGATE_COMMAND_IMMUTABLE", 409)
      }
      return existing
    }
    if (input.transaction) return work(input.transaction)
    return options.sql.transaction(work)
  }

  const recordReport = async (input: {
    tenantId: string
    report: unknown
  }): Promise<GatewayAggregateReportResult> => {
    let parsed: GatewayRuntimeReport
    try {
      parsed = parseGatewayRuntimeReport(input.report)
    } catch (error) {
      throw new PlatformApiError(
        "RUNTIME_PROTOCOL_INVALID",
        422,
        error instanceof Error ? error.message : "Runtime report is invalid",
      )
    }
    if (parsed.tenant_id !== input.tenantId) {
      throw new PlatformApiError("RUNTIME_REPORT_SCOPE_MISMATCH", 403)
    }
    runtimeIdentifier(input.tenantId, "TENANT_REQUIRED")
    return options.sql.transaction(async (transaction) => {
      const registration = await requireActiveRuntime(
        transaction,
        input.tenantId,
        parsed.runtime_id,
        now,
        true,
      )
      let verifiedEnvelope: GatewayRuntimeReport
      try {
        verifiedEnvelope = verifyRuntimeMessage({
          message: parsed,
          publicKeyPem: registration.report_public_key_pem,
          expectedKeyId: registration.report_key_id,
        }) as GatewayRuntimeReport
      } catch (error) {
        throw error
      }

      const currentRow = await selectObserved(
        transaction,
        input.tenantId,
        parsed.runtime_id,
        true,
      )
      const current = currentRow ? mapObserved(currentRow, now) : null
      const duplicateRow = await selectHistory(
        transaction,
        input.tenantId,
        parsed.runtime_id,
        parsed.report_id,
        true,
      )
      if (duplicateRow) {
        const existing = mapHistory(duplicateRow)
        if (existing.digest !== verifiedEnvelope.digest) {
          throw new PlatformApiError("RUNTIME_REPORT_IMMUTABLE", 409)
        }
        if (!current) throw new PlatformApiError("RUNTIME_AGGREGATE_DATA_INVALID", 500)
        return {
          report: verifiedEnvelope,
          outcome: existing.outcome,
          observed: current,
        }
      }

      const commandRow = await selectCommand(transaction, {
        tenantId: input.tenantId,
        runtimeId: parsed.runtime_id,
        commandId: parsed.command_id,
      }, true)
      if (!commandRow) throw new PlatformApiError("RUNTIME_COMMAND_NOT_FOUND", 404)
      const command = mapCommand(commandRow, now, publicKey, options.signer?.keyId)
      const verified = verifyGatewayReleaseReport({
        report: parsed,
        publicKeyPem: registration.report_public_key_pem,
        reportKeyId: registration.report_key_id,
        tenantId: input.tenantId,
        runtimeId: parsed.runtime_id,
        commandId: command.command_id,
        desiredRelease: command.command.desired_release,
        priorAppliedRelease: current?.applied_release ?? null,
      })
      const stale = current !== null && compareRevision(verified.revision, current.revision) < 0
      if (!stale && current !== null && compareRevision(verified.revision, current.revision) === 0) {
        const incoming = verified.observed_status.applied_release ?? current.applied_release
        if (
          current.applied_release &&
          incoming &&
          !gatewayReleaseReferencesEqual(current.applied_release, incoming) &&
          !(
            command.state === "PENDING" &&
            current.command_id === command.command_id &&
            (current.observed_status.state === "APPLYING" ||
              current.observed_status.state === "UNKNOWN") &&
            verified.observed_status.state === "READY" &&
            gatewayReleaseReferencesEqual(incoming, command.command.desired_release)
          )
        ) {
          throw new PlatformApiError("RUNTIME_REPORT_RELEASE_CONFLICT", 409)
        }
      }

      const historyInsert = await transaction.query<DatabaseRow>(
        `insert into genio_one_platform_runtime_aggregate_report_history
           (tenant_id, runtime_kind, runtime_id, report_id, command_id,
            release_id, package_digest, revision, digest, report, outcome)
         values ($1, 'GATEWAY', $2, $3, $4, $5, $6, $7, $8, $9::text::jsonb, $10)
         on conflict (tenant_id, runtime_kind, runtime_id, report_id) do nothing
         returning ${REPORT_COLUMNS}`,
        [
          input.tenantId,
          verified.runtime_id,
          verified.report_id,
          verified.command_id,
          command.release_id,
          command.package_digest,
          verified.revision,
          verified.digest,
          JSON.stringify(verified),
          stale ? "STALE" : "ACCEPTED",
        ],
      )
      let history: GatewayAggregateReportHistoryRecord
      if (historyInsert.rows[0]) {
        history = mapHistory(historyInsert.rows[0])
      } else {
        const raced = await selectHistory(
          transaction,
          input.tenantId,
          verified.runtime_id,
          verified.report_id,
          true,
        )
        if (!raced) throw new PlatformApiError("RUNTIME_REPORT_WRITE_RACE", 500)
        history = mapHistory(raced)
        if (history.digest !== verified.digest) {
          throw new PlatformApiError("RUNTIME_REPORT_IMMUTABLE", 409)
        }
        if (!current) throw new PlatformApiError("RUNTIME_OBSERVED_STATE_UNAVAILABLE", 500)
        return { report: verified, outcome: history.outcome, observed: current }
      }

      let observed = current
      if (!stale) {
        const appliedRelease = verified.observed_status.applied_release ?? current?.applied_release ?? null
        const observedInsert = await transaction.query<DatabaseRow>(
          `insert into genio_one_platform_runtime_aggregate_observed_states
             (tenant_id, runtime_kind, runtime_id, command_id, report_id,
              revision, digest, applied_release, observed_status)
           values ($1, 'GATEWAY', $2, $3, $4, $5, $6, $7::text::jsonb, $8::text::jsonb)
           on conflict (tenant_id, runtime_kind, runtime_id)
           do update set command_id = excluded.command_id,
                         report_id = excluded.report_id,
                         revision = excluded.revision,
                         digest = excluded.digest,
                         applied_release = excluded.applied_release,
                         observed_status = excluded.observed_status,
                         observed_at = now(),
                         updated_at = now()
           returning ${OBSERVED_COLUMNS}`,
          [
            input.tenantId,
            verified.runtime_id,
            verified.command_id,
            verified.report_id,
            verified.revision,
            verified.digest,
            appliedRelease === null ? null : JSON.stringify(appliedRelease),
            JSON.stringify(verified.observed_status),
          ],
        )
        if (!observedInsert.rows[0]) {
          throw new PlatformApiError("RUNTIME_OBSERVED_STATE_WRITE_FAILED", 500)
        }
        observed = mapObserved(observedInsert.rows[0], now)
        if (command.state === "PENDING") {
          switch (verified.observed_status.state) {
            case "READY":
              await transaction.query(
                `update genio_one_platform_runtime_aggregate_commands
                    set state = 'ACKNOWLEDGED', acknowledged_at = now(), updated_at = now()
                  where tenant_id = $1 and runtime_kind = 'GATEWAY'
                    and runtime_id = $2 and command_id = $3 and state = 'PENDING'`,
                [input.tenantId, verified.runtime_id, command.command_id],
              )
              break
            case "DEGRADED": {
              const failureCode = verified.observed_status.error?.code ??
                "RUNTIME_APPLY_DEGRADED"
              const failureMessage = verified.observed_status.error?.message ??
                "Gateway runtime reported a degraded state while applying the release"
              await transaction.query(
                `update genio_one_platform_runtime_aggregate_commands
                    set state = 'FAILED', failure_code = $4, failure_message = $5,
                        failed_at = now(), updated_at = now()
                  where tenant_id = $1 and runtime_kind = 'GATEWAY'
                    and runtime_id = $2 and command_id = $3 and state = 'PENDING'`,
                [input.tenantId, verified.runtime_id, command.command_id, failureCode, failureMessage],
              )
              break
            }
            case "APPLYING":
            case "UNKNOWN":
              // These observations are non-terminal. The command remains
              // pending until the runtime reports a complete READY state.
              await transaction.query(
                `update genio_one_platform_runtime_aggregate_commands
                    set updated_at = now()
                  where tenant_id = $1 and runtime_kind = 'GATEWAY'
                    and runtime_id = $2 and command_id = $3 and state = 'PENDING'`,
                [input.tenantId, verified.runtime_id, command.command_id],
              )
              break
          }
        }
      }
      if (!observed) throw new PlatformApiError("RUNTIME_OBSERVED_STATE_UNAVAILABLE", 500)
      return { report: verified, outcome: history.outcome, observed }
    })
  }

  return {
    async saveCapabilities(input) {
      const versions = validateCapabilityInput(input)
      return options.sql.transaction(async (transaction) => {
        await lockRuntimeTopology({ transaction, tenantId: input.tenantId })
        await requireActiveRuntime(transaction, input.tenantId, input.runtimeId, now, true)
        const currentRow = await selectCapability(
          transaction,
          input.tenantId,
          input.runtimeId,
          true,
        )
        if (currentRow) {
          const current = mapCapabilities(currentRow, now)
          if (capabilityMatches(current, input, versions)) return current
          const updated = await transaction.query<DatabaseRow>(
            `update genio_one_platform_runtime_capabilities
                set protocol_versions = $3::text::jsonb,
                    preferred_protocol_version = $4,
                    delivery_mode = $5,
                    row_revision = row_revision + 1,
                    updated_at = now()
              where tenant_id = $1 and runtime_kind = 'GATEWAY' and runtime_id = $2
              returning ${CAPABILITY_COLUMNS}`,
            [input.tenantId, input.runtimeId, JSON.stringify(versions), input.preferredProtocolVersion, input.deliveryMode],
          )
          if (!updated.rows[0]) throw new PlatformApiError("RUNTIME_CAPABILITIES_WRITE_RACE", 500)
          return mapCapabilities(updated.rows[0], now)
        }
        const inserted = await transaction.query<DatabaseRow>(
          `insert into genio_one_platform_runtime_capabilities
             (tenant_id, runtime_kind, runtime_id, protocol_versions,
              preferred_protocol_version, delivery_mode)
           values ($1, 'GATEWAY', $2, $3::text::jsonb, $4, $5)
           returning ${CAPABILITY_COLUMNS}`,
          [input.tenantId, input.runtimeId, JSON.stringify(versions), input.preferredProtocolVersion, input.deliveryMode],
        )
        if (!inserted.rows[0]) throw new PlatformApiError("RUNTIME_CAPABILITIES_WRITE_RACE", 500)
        return mapCapabilities(inserted.rows[0], now)
      })
    },

    async getCapabilities(input) {
      if (input.runtimeKind !== undefined && input.runtimeKind !== "GATEWAY") return null
      runtimeIdentifier(input.tenantId, "TENANT_REQUIRED")
      runtimeIdentifier(input.runtimeId, "RUNTIME_ID_REQUIRED")
      const row = await selectCapability(options.sql, input.tenantId, input.runtimeId)
      return row ? mapCapabilities(row, now) : null
    },

    selectGatewayGroupInTransaction,

    enqueueGatewayRelease: enqueue,
    enqueueGatewayReleaseInTransaction: enqueue,

    async listPendingGatewayReleaseCommands(input) {
      if (input.runtimeKind !== undefined && input.runtimeKind !== "GATEWAY") return []
      runtimeIdentifier(input.tenantId, "TENANT_REQUIRED")
      runtimeIdentifier(input.runtimeId, "RUNTIME_ID_REQUIRED")
      const result = await options.sql.query<DatabaseRow>(
        `select ${COMMAND_COLUMNS}
           from genio_one_platform_runtime_aggregate_commands
          where tenant_id = $1 and runtime_kind = 'GATEWAY'
            and runtime_id = $2 and state = 'PENDING'
            and not exists (
              select 1
                from genio_one_platform_runtime_aggregate_observed_states observed
               where observed.tenant_id = $1
                 and observed.runtime_kind = 'GATEWAY'
                 and observed.runtime_id = $2
                 and observed.observed_status ->> 'state' in ('READY', 'DEGRADED')
                 and observed.revision::bigint >=
                   genio_one_platform_runtime_aggregate_commands.head_revision
            )
            and exists (
              select 1
                from genio_one_platform_runtime_registrations registration
               where registration.tenant_id = $1
                 and registration.runtime_kind = 'GATEWAY'
                 and registration.runtime_id = $2
                 and registration.status = 'ACTIVE'
            )
          order by head_revision desc, created_at desc, command_id desc
          limit 1`,
        [input.tenantId, input.runtimeId],
      )
      return result.rows.map((row) => mapCommand(row, now, publicKey, options.signer?.keyId))
    },

    async getGatewayReleaseCommand(input) {
      if (input.runtimeKind !== undefined && input.runtimeKind !== "GATEWAY") return null
      runtimeIdentifier(input.tenantId, "TENANT_REQUIRED")
      runtimeIdentifier(input.runtimeId, "RUNTIME_ID_REQUIRED")
      runtimeIdentifier(input.commandId, "RUNTIME_COMMAND_ID_REQUIRED")
      const row = await selectCommand(options.sql, input)
      return row ? mapCommand(row, now, publicKey, options.signer?.keyId) : null
    },

    async markGatewayReleaseCommandDelivered(input) {
      runtimeIdentifier(input.tenantId, "TENANT_REQUIRED")
      runtimeIdentifier(input.runtimeId, "RUNTIME_ID_REQUIRED")
      runtimeIdentifier(input.commandId, "RUNTIME_COMMAND_ID_REQUIRED")
      return options.sql.transaction(async (transaction) => {
        const row = await selectCommand(transaction, input, true)
        if (!row) throw new PlatformApiError("RUNTIME_COMMAND_NOT_FOUND", 404)
        const current = mapCommand(row, now, publicKey, options.signer?.keyId)
        if (current.state === "FAILED") {
          throw new PlatformApiError("RUNTIME_COMMAND_STATE_CONFLICT", 409)
        }
        if (current.delivered_at !== null) return current
        const updated = await transaction.query<DatabaseRow>(
          `update genio_one_platform_runtime_aggregate_commands
              set delivered_at = now(), updated_at = now()
            where tenant_id = $1 and runtime_kind = 'GATEWAY'
              and runtime_id = $2 and command_id = $3
              and state in ('PENDING', 'ACKNOWLEDGED')
              and delivered_at is null
            returning ${COMMAND_COLUMNS}`,
          [input.tenantId, input.runtimeId, input.commandId],
        )
        if (!updated.rows[0]) throw new PlatformApiError("RUNTIME_COMMAND_STATE_CONFLICT", 409)
        return mapCommand(updated.rows[0], now, publicKey, options.signer?.keyId)
      })
    },

    recordGatewayReleaseReport: recordReport,

    async getLatestGatewayReleaseObserved(input) {
      if (input.runtimeKind !== undefined && input.runtimeKind !== "GATEWAY") return null
      runtimeIdentifier(input.tenantId, "TENANT_REQUIRED")
      runtimeIdentifier(input.runtimeId, "RUNTIME_ID_REQUIRED")
      const row = await selectObserved(options.sql, input.tenantId, input.runtimeId)
      return row ? mapObserved(row, now) : null
    },

    async listGatewayReleaseReportHistory(input) {
      if (input.runtimeKind !== undefined && input.runtimeKind !== "GATEWAY") return []
      runtimeIdentifier(input.tenantId, "TENANT_REQUIRED")
      runtimeIdentifier(input.runtimeId, "RUNTIME_ID_REQUIRED")
      const result = await options.sql.query<DatabaseRow>(
        `select ${REPORT_COLUMNS}
           from genio_one_platform_runtime_aggregate_report_history
          where tenant_id = $1 and runtime_kind = 'GATEWAY' and runtime_id = $2
          order by observed_at asc, report_id asc`,
        [input.tenantId, input.runtimeId],
      )
      return result.rows.map(mapHistory)
    },
  }
}
