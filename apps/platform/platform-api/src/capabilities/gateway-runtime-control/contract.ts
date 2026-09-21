import { Type, type Static } from "typebox"

import type { SqlTransaction } from "../../persistence/sql-adapter"
import {
  GatewayObservedStateSchema,
  GatewayReleaseReferenceSchema,
  GatewayRuntimeCommandSchema,
  GatewayRuntimeReportSchema,
  type GatewayRuntimeReport,
} from "@genioone/protocol/gateway-release"
import type { RuntimeRegistrationKey } from "../runtime-control/contract"
import { RUNTIME_PROTOCOL_SCHEMA_VERSION } from "@genioone/protocol/runtime-command"

const Identifier = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[^\\u0000\\r\\n]+$",
})
const Digest = Type.String({ pattern: "^[a-f0-9]{64}$" })
const Timestamp = Type.Integer({ minimum: 0 })

const RuntimeCommandStateSchema = Type.Union([
  Type.Literal("PENDING"),
  Type.Literal("ACKNOWLEDGED"),
  Type.Literal("FAILED"),
])

const RuntimeReportHistoryOutcomeSchema = Type.Union([
  Type.Literal("ACCEPTED"),
  Type.Literal("STALE"),
])

const RUNTIME_PROTOCOL_VERSIONS = [RUNTIME_PROTOCOL_SCHEMA_VERSION] as const
export type RuntimeProtocolVersion = (typeof RUNTIME_PROTOCOL_VERSIONS)[number]

export const RuntimeProtocolVersionSchema = Type.Literal(RUNTIME_PROTOCOL_SCHEMA_VERSION)

const GATEWAY_AGGREGATE_DELIVERY_MODE = "AGGREGATE_RELEASE" as const
export const GatewayAggregateDeliveryModeSchema = Type.Literal(GATEWAY_AGGREGATE_DELIVERY_MODE)
export type GatewayAggregateDeliveryMode = Static<typeof GatewayAggregateDeliveryModeSchema>

export function supportsGatewayAggregateDelivery(input: {
  protocolVersions: readonly string[]
  preferredProtocolVersion: string
  deliveryMode: string
}): boolean {
  return input.protocolVersions.length === RUNTIME_PROTOCOL_VERSIONS.length &&
    input.protocolVersions.every((value, index) => value === RUNTIME_PROTOCOL_VERSIONS[index]) &&
    input.preferredProtocolVersion === RUNTIME_PROTOCOL_SCHEMA_VERSION &&
    input.deliveryMode === GATEWAY_AGGREGATE_DELIVERY_MODE
}

export const GatewayRuntimeCapabilitiesSchema = Type.Object({
  tenant_id: Identifier,
  runtime_kind: Type.Literal("GATEWAY"),
  runtime_id: Identifier,
  protocol_versions: Type.Array(RuntimeProtocolVersionSchema, { minItems: 1, maxItems: 1 }),
  preferred_protocol_version: RuntimeProtocolVersionSchema,
  delivery_mode: GatewayAggregateDeliveryModeSchema,
  row_revision: Type.Integer({ minimum: 1 }),
  created_at: Timestamp,
  updated_at: Timestamp,
}, { additionalProperties: false })

export const GatewayAggregateCommandRecordSchema = Type.Object({
  tenant_id: Identifier,
  runtime_kind: Type.Literal("GATEWAY"),
  runtime_id: Identifier,
  command_id: Identifier,
  release_id: Identifier,
  gateway_id: Identifier,
  head_revision: Type.Integer({ minimum: 1 }),
  package_digest: Digest,
  projection_count: Type.Integer({ minimum: 0 }),
  command: GatewayRuntimeCommandSchema,
  state: RuntimeCommandStateSchema,
  failure_code: Type.Union([Identifier, Type.Null()]),
  failure_message: Type.Union([
    Type.String({ minLength: 1, maxLength: 2048 }),
    Type.Null(),
  ]),
  created_at: Timestamp,
  delivered_at: Type.Union([Timestamp, Type.Null()]),
  acknowledged_at: Type.Union([Timestamp, Type.Null()]),
  failed_at: Type.Union([Timestamp, Type.Null()]),
  updated_at: Timestamp,
}, { additionalProperties: false })

export const GatewayAggregateObservedStateRecordSchema = Type.Object({
  tenant_id: Identifier,
  runtime_kind: Type.Literal("GATEWAY"),
  runtime_id: Identifier,
  command_id: Identifier,
  report_id: Identifier,
  revision: Type.String({ minLength: 1, maxLength: 128 }),
  digest: Digest,
  /** Effective trusted LKG, retained when a non-ready report omits it. */
  applied_release: Type.Union([GatewayReleaseReferenceSchema, Type.Null()]),
  observed_status: GatewayObservedStateSchema,
  observed_at: Timestamp,
  updated_at: Timestamp,
}, { additionalProperties: false })

export const GatewayAggregateReportHistoryRecordSchema = Type.Object({
  tenant_id: Identifier,
  runtime_kind: Type.Literal("GATEWAY"),
  runtime_id: Identifier,
  report_id: Identifier,
  command_id: Identifier,
  release_id: Identifier,
  package_digest: Digest,
  revision: Type.String({ minLength: 1, maxLength: 128 }),
  digest: Digest,
  report: GatewayRuntimeReportSchema,
  outcome: RuntimeReportHistoryOutcomeSchema,
  observed_at: Timestamp,
}, { additionalProperties: false })

export type GatewayRuntimeCapabilities = Static<typeof GatewayRuntimeCapabilitiesSchema>
export type GatewayAggregateCommandRecord = Static<typeof GatewayAggregateCommandRecordSchema>
export type GatewayAggregateObservedStateRecord = Static<
  typeof GatewayAggregateObservedStateRecordSchema
>
export type GatewayAggregateReportHistoryRecord = Static<
  typeof GatewayAggregateReportHistoryRecordSchema
>

/** A Publication targets one Gateway Group; every eligible replica receives it. */
export const GatewayAggregateRuntimeGroupSchema = Type.Object({
  tenant_id: Identifier,
  gateway_id: Identifier,
  runtime_ids: Type.Array(Identifier, { minItems: 1 }),
}, { additionalProperties: false })

export type GatewayAggregateRuntimeGroup = Static<typeof GatewayAggregateRuntimeGroupSchema>

/**
 * Transaction-scoped Gateway Group resolution. Runtime IDs are concrete
 * replicas, not independent publication targets, and are returned in a stable
 * order so one transaction can enqueue the same release to the whole group.
 */
export interface GatewayAggregateRuntimeSelector {
  selectGatewayGroupInTransaction(input: {
    transaction: SqlTransaction
    tenantId: string
    gatewayId: string
  }): Promise<GatewayAggregateRuntimeGroup>
}

export interface SaveGatewayRuntimeCapabilitiesInput {
  tenantId: string
  runtimeId: string
  protocolVersions: readonly RuntimeProtocolVersion[]
  preferredProtocolVersion: RuntimeProtocolVersion
  deliveryMode: GatewayAggregateDeliveryMode
}

export interface EnqueueGatewayReleaseInput {
  tenantId: string
  runtimeId: string
  release: Static<typeof GatewayReleaseReferenceSchema>
  transaction?: SqlTransaction
}

export interface GatewayAggregateReportResult {
  report: GatewayRuntimeReport
  outcome: Static<typeof RuntimeReportHistoryOutcomeSchema>
  observed: GatewayAggregateObservedStateRecord
}

export interface GatewayAggregateRuntimeControlStore {
  saveCapabilities(input: SaveGatewayRuntimeCapabilitiesInput): Promise<GatewayRuntimeCapabilities>
  getCapabilities(input: RuntimeRegistrationKey): Promise<GatewayRuntimeCapabilities | null>
  enqueueGatewayRelease(input: EnqueueGatewayReleaseInput): Promise<GatewayAggregateCommandRecord>
  enqueueGatewayReleaseInTransaction(
    input: EnqueueGatewayReleaseInput & { transaction: SqlTransaction },
  ): Promise<GatewayAggregateCommandRecord>
  listPendingGatewayReleaseCommands(
    input: RuntimeRegistrationKey,
  ): Promise<GatewayAggregateCommandRecord[]>
  getGatewayReleaseCommand(
    input: RuntimeRegistrationKey & { commandId: string },
  ): Promise<GatewayAggregateCommandRecord | null>
  markGatewayReleaseCommandDelivered(
    input: RuntimeRegistrationKey & { commandId: string },
  ): Promise<GatewayAggregateCommandRecord>
  recordGatewayReleaseReport(input: {
    tenantId: string
    report: unknown
  }): Promise<GatewayAggregateReportResult>
  getLatestGatewayReleaseObserved(
    input: RuntimeRegistrationKey,
  ): Promise<GatewayAggregateObservedStateRecord | null>
  listGatewayReleaseReportHistory(
    input: RuntimeRegistrationKey,
  ): Promise<GatewayAggregateReportHistoryRecord[]>
}

export interface GatewayAggregateReleaseScheduler {
  enqueueGatewayReleaseInTransaction(
    input: EnqueueGatewayReleaseInput & { transaction: SqlTransaction },
  ): Promise<GatewayAggregateCommandRecord>
}
