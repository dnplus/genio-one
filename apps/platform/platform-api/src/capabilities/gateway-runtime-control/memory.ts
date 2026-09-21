import { randomUUID } from "node:crypto"

import { Check } from "typebox/value"

import type { GatewayProjectionSigner } from "../gateway-projection/contract"
import { PlatformApiError } from "../errors"
import {
  GatewayReleaseReferenceSchema,
  parseGatewayRuntimeReport,
  type GatewayRuntimeReport,
} from "@genioone/protocol/gateway-release"
import type { RuntimeControlStore } from "../runtime-control/contract"
import {
  gatewayReleaseReferencesEqual,
  signGatewayReleaseCommand,
  verifyGatewayReleaseReport,
  verifyRuntimeMessage,
} from "../runtime-control/gateway-release-integrity"
import { supportsGatewayAggregateDelivery } from "./contract"
import type {
  EnqueueGatewayReleaseInput,
  GatewayAggregateCommandRecord,
  GatewayAggregateObservedStateRecord,
  GatewayAggregateReportHistoryRecord,
  GatewayAggregateReportResult,
  GatewayAggregateRuntimeControlStore,
  GatewayRuntimeCapabilities,
  RuntimeProtocolVersion,
  SaveGatewayRuntimeCapabilitiesInput,
} from "./contract"

export interface InMemoryGatewayAggregateRuntimeControlStoreOptions {
  registrations: Pick<RuntimeControlStore, "getGatewayRuntime">
  signer?: GatewayProjectionSigner
  now?: () => number
  idFactory?: (prefix: string, sequence: number) => string
}

function runtimeKey(tenantId: string, runtimeId: string): string {
  return `${tenantId}\u0000GATEWAY\u0000${runtimeId}`
}

function commandKey(tenantId: string, runtimeId: string, commandId: string): string {
  return `${runtimeKey(tenantId, runtimeId)}\u0000${commandId}`
}

function releaseKey(tenantId: string, runtimeId: string, releaseId: string): string {
  return `${runtimeKey(tenantId, runtimeId)}\u0000${releaseId}`
}

function reportKey(tenantId: string, runtimeId: string, reportId: string): string {
  return `${runtimeKey(tenantId, runtimeId)}\u0000${reportId}`
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function requireIdentifier(value: string, code: string): void {
  if (!value.trim() || value.trim() !== value || /[\u0000\r\n]/.test(value)) {
    throw new PlatformApiError(code, 422)
  }
}

function validatedProtocols(input: SaveGatewayRuntimeCapabilitiesInput): RuntimeProtocolVersion[] {
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

function compareRevision(left: string, right: string): number {
  const leftNumber = Number(left)
  const rightNumber = Number(right)
  if (!Number.isSafeInteger(leftNumber) || !Number.isSafeInteger(rightNumber)) {
    throw new PlatformApiError("RUNTIME_AGGREGATE_REVISION_INVALID", 500)
  }
  return leftNumber - rightNumber
}

function commandReference(record: GatewayAggregateCommandRecord) {
  return record.command.desired_release
}

export function createInMemoryGatewayAggregateRuntimeControlStore(
  options: InMemoryGatewayAggregateRuntimeControlStoreOptions,
): GatewayAggregateRuntimeControlStore {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const capabilities = new Map<string, GatewayRuntimeCapabilities>()
  const commands = new Map<string, GatewayAggregateCommandRecord>()
  const commandsByRelease = new Map<string, string>()
  const observations = new Map<string, GatewayAggregateObservedStateRecord>()
  const history = new Map<string, GatewayAggregateReportHistoryRecord[]>()
  const reports = new Map<string, GatewayAggregateReportHistoryRecord>()
  let sequence = 0

  const createId = (prefix: string): string => {
    sequence += 1
    return options.idFactory
      ? options.idFactory(prefix, sequence)
      : `${prefix}-${randomUUID()}`
  }

  const registration = async (tenantId: string, runtimeId: string, activeOnly = true) => {
    const value = await options.registrations.getGatewayRuntime({
      tenantId,
      runtimeKind: "GATEWAY",
      runtimeId,
    })
    if (!value) throw new PlatformApiError("RUNTIME_RUNTIME_NOT_REGISTERED", 404)
    if (activeOnly && value.status !== "ACTIVE") {
      throw new PlatformApiError("RUNTIME_RUNTIME_NOT_ACTIVE", 403)
    }
    return value
  }

  const saveCapabilities = async (
    input: SaveGatewayRuntimeCapabilitiesInput,
  ): Promise<GatewayRuntimeCapabilities> => {
    requireIdentifier(input.tenantId, "TENANT_REQUIRED")
    requireIdentifier(input.runtimeId, "RUNTIME_ID_REQUIRED")
    await registration(input.tenantId, input.runtimeId)
    const versions = validatedProtocols(input)
    const key = runtimeKey(input.tenantId, input.runtimeId)
    const current = capabilities.get(key)
    if (
      current &&
      current.protocol_versions.length === versions.length &&
      current.protocol_versions.every((value, index) => value === versions[index]) &&
      current.preferred_protocol_version === input.preferredProtocolVersion &&
      current.delivery_mode === input.deliveryMode
    ) return clone(current)
    const timestamp = now()
    const saved: GatewayRuntimeCapabilities = {
      tenant_id: input.tenantId,
      runtime_kind: "GATEWAY",
      runtime_id: input.runtimeId,
      protocol_versions: versions,
      preferred_protocol_version: input.preferredProtocolVersion,
      delivery_mode: input.deliveryMode,
      row_revision: (current?.row_revision ?? 0) + 1,
      created_at: current?.created_at ?? timestamp,
      updated_at: timestamp,
    }
    capabilities.set(key, saved)
    return clone(saved)
  }

  const getCommand = (
    tenantId: string,
    runtimeId: string,
    commandId: string,
  ): GatewayAggregateCommandRecord | null =>
    clone(commands.get(commandKey(tenantId, runtimeId, commandId)) ?? null)

  const enqueue = async (
    input: EnqueueGatewayReleaseInput,
  ): Promise<GatewayAggregateCommandRecord> => {
    requireIdentifier(input.tenantId, "TENANT_REQUIRED")
    requireIdentifier(input.runtimeId, "RUNTIME_ID_REQUIRED")
    if (!Check(GatewayReleaseReferenceSchema, input.release)) {
      throw new PlatformApiError("RUNTIME_RELEASE_REFERENCE_INVALID", 422)
    }
    if (!options.signer) {
      throw new PlatformApiError(
        "RUNTIME_COMMAND_SIGNER_REQUIRED",
        500,
        "A durable runtime command signer is required",
      )
    }
    const runtime = await registration(input.tenantId, input.runtimeId)
    if (runtime.target_id !== input.release.gateway_id) {
      throw new PlatformApiError("RUNTIME_RELEASE_TARGET_MISMATCH", 409)
    }
    const capability = capabilities.get(runtimeKey(input.tenantId, input.runtimeId))
    if (
      !capability ||
      !supportsGatewayAggregateDelivery({
        protocolVersions: capability.protocol_versions,
        preferredProtocolVersion: capability.preferred_protocol_version,
        deliveryMode: capability.delivery_mode,
      })
    ) {
      throw new PlatformApiError("RUNTIME_AGGREGATE_DELIVERY_UNSUPPORTED", 409)
    }
    const existingId = commandsByRelease.get(
      releaseKey(input.tenantId, input.runtimeId, input.release.release_id),
    )
    if (existingId) {
      const existing = commands.get(existingId)
      if (!existing) throw new PlatformApiError("RUNTIME_AGGREGATE_DATA_INVALID", 500)
      if (!gatewayReleaseReferencesEqual(existing.command.desired_release, input.release)) {
        throw new PlatformApiError("RUNTIME_AGGREGATE_COMMAND_IMMUTABLE", 409)
      }
      return clone(existing)
    }
    const command = await signGatewayReleaseCommand({
      tenantId: input.tenantId,
      runtimeId: input.runtimeId,
      release: input.release,
      signer: options.signer,
      commandId: createId("gateway-release-command"),
    })
    const timestamp = now()
    const record: GatewayAggregateCommandRecord = {
      tenant_id: input.tenantId,
      runtime_kind: "GATEWAY",
      runtime_id: input.runtimeId,
      command_id: command.command_id,
      release_id: input.release.release_id,
      gateway_id: input.release.gateway_id,
      head_revision: input.release.head_revision,
      package_digest: input.release.package_digest,
      projection_count: input.release.projection_count,
      command,
      state: "PENDING",
      failure_code: null,
      failure_message: null,
      created_at: timestamp,
      delivered_at: null,
      acknowledged_at: null,
      failed_at: null,
      updated_at: timestamp,
    }
    const key = commandKey(input.tenantId, input.runtimeId, command.command_id)
    commands.set(key, record)
    commandsByRelease.set(
      releaseKey(input.tenantId, input.runtimeId, input.release.release_id),
      key,
    )
    return clone(record)
  }

  const recordReport = async (
    tenantId: string,
    rawReport: unknown,
  ): Promise<GatewayAggregateReportResult> => {
    let parsed: GatewayRuntimeReport
    try {
      parsed = parseGatewayRuntimeReport(rawReport)
    } catch (error) {
      throw new PlatformApiError(
        "RUNTIME_PROTOCOL_INVALID",
        422,
        error instanceof Error ? error.message : "Runtime report is invalid",
      )
    }
    if (parsed.tenant_id !== tenantId) {
      throw new PlatformApiError("RUNTIME_REPORT_SCOPE_MISMATCH", 403)
    }
    const runtime = await registration(tenantId, parsed.runtime_id)
    const verifiedEnvelope = verifyRuntimeMessage({
      message: parsed,
      publicKeyPem: runtime.report_public_key_pem,
      expectedKeyId: runtime.report_key_id,
    }) as GatewayRuntimeReport
    const priorReport = reports.get(reportKey(tenantId, parsed.runtime_id, parsed.report_id))
    const current = observations.get(runtimeKey(tenantId, parsed.runtime_id))
    if (priorReport) {
      if (priorReport.digest !== verifiedEnvelope.digest) {
        throw new PlatformApiError("RUNTIME_REPORT_IMMUTABLE", 409)
      }
      if (!current) throw new PlatformApiError("RUNTIME_AGGREGATE_DATA_INVALID", 500)
      return {
        report: clone(verifiedEnvelope),
        outcome: priorReport.outcome,
        observed: clone(current),
      }
    }
    const command = commands.get(commandKey(tenantId, parsed.runtime_id, parsed.command_id))
    if (!command) throw new PlatformApiError("RUNTIME_COMMAND_NOT_FOUND", 404)
    const verified = verifyGatewayReleaseReport({
      report: parsed,
      publicKeyPem: runtime.report_public_key_pem,
      reportKeyId: runtime.report_key_id,
      tenantId,
      runtimeId: parsed.runtime_id,
      commandId: command.command_id,
      desiredRelease: commandReference(command),
      priorAppliedRelease: current?.applied_release ?? null,
    })
    const stale = current !== undefined && compareRevision(verified.revision, current.revision) < 0
    if (
      !stale &&
      current !== undefined &&
      compareRevision(verified.revision, current.revision) === 0
    ) {
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
          gatewayReleaseReferencesEqual(incoming, commandReference(command))
        )
      ) {
        throw new PlatformApiError("RUNTIME_REPORT_RELEASE_CONFLICT", 409)
      }
    }
    const timestamp = now()
    const historyRecord: GatewayAggregateReportHistoryRecord = {
      tenant_id: tenantId,
      runtime_kind: "GATEWAY",
      runtime_id: verified.runtime_id,
      report_id: verified.report_id,
      command_id: verified.command_id,
      release_id: command.release_id,
      package_digest: command.package_digest,
      revision: verified.revision,
      digest: verified.digest,
      report: clone(verified),
      outcome: stale ? "STALE" : "ACCEPTED",
      observed_at: timestamp,
    }
    reports.set(reportKey(tenantId, verified.runtime_id, verified.report_id), historyRecord)
    const entries = history.get(runtimeKey(tenantId, verified.runtime_id)) ?? []
    entries.push(historyRecord)
    history.set(runtimeKey(tenantId, verified.runtime_id), entries)

    if (!stale) {
      const observed: GatewayAggregateObservedStateRecord = {
        tenant_id: tenantId,
        runtime_kind: "GATEWAY",
        runtime_id: verified.runtime_id,
        command_id: verified.command_id,
        report_id: verified.report_id,
        revision: verified.revision,
        digest: verified.digest,
        applied_release: clone(
          verified.observed_status.applied_release ?? current?.applied_release ?? null,
        ),
        observed_status: clone(verified.observed_status),
        observed_at: timestamp,
        updated_at: timestamp,
      }
      observations.set(runtimeKey(tenantId, verified.runtime_id), observed)
      if (command.state === "PENDING") {
        switch (verified.observed_status.state) {
          case "READY":
            command.state = "ACKNOWLEDGED"
            command.acknowledged_at = timestamp
            break
          case "DEGRADED":
            command.state = "FAILED"
            command.failure_code = verified.observed_status.error?.code ??
              "RUNTIME_APPLY_DEGRADED"
            command.failure_message = verified.observed_status.error?.message ??
              "Gateway runtime reported a degraded state while applying the release"
            command.failed_at = timestamp
            break
          case "APPLYING":
          case "UNKNOWN":
            // These are non-terminal observations. Keep the command pending
            // until the runtime proves the target release is READY.
            break
        }
        command.updated_at = timestamp
      }
    }
    const observed = observations.get(runtimeKey(tenantId, verified.runtime_id))
    if (!observed) throw new PlatformApiError("RUNTIME_OBSERVED_STATE_UNAVAILABLE", 500)
    return { report: clone(verified), outcome: historyRecord.outcome, observed: clone(observed) }
  }

  return {
    saveCapabilities,
    async getCapabilities(input) {
      if (input.runtimeKind !== undefined && input.runtimeKind !== "GATEWAY") return null
      return clone(capabilities.get(runtimeKey(input.tenantId, input.runtimeId)) ?? null)
    },
    enqueueGatewayRelease: enqueue,
    enqueueGatewayReleaseInTransaction: enqueue,
    async listPendingGatewayReleaseCommands(input) {
      if (input.runtimeKind !== undefined && input.runtimeKind !== "GATEWAY") return []
      const appliedRevision = observations.get(runtimeKey(input.tenantId, input.runtimeId))
        ?.applied_release?.head_revision
      return [...commands.values()]
        .filter((value) => value.tenant_id === input.tenantId &&
          value.runtime_id === input.runtimeId && value.state === "PENDING" &&
          (appliedRevision === undefined || value.head_revision > appliedRevision))
        .sort((left, right) => right.head_revision - left.head_revision ||
          right.command_id.localeCompare(left.command_id))
        .slice(0, 1)
        .map(clone)
    },
    async getGatewayReleaseCommand(input) {
      if (input.runtimeKind !== undefined && input.runtimeKind !== "GATEWAY") return null
      return getCommand(input.tenantId, input.runtimeId, input.commandId)
    },
    async markGatewayReleaseCommandDelivered(input) {
      const record = commands.get(commandKey(input.tenantId, input.runtimeId, input.commandId))
      if (!record) throw new PlatformApiError("RUNTIME_COMMAND_NOT_FOUND", 404)
      if (record.state === "FAILED") {
        throw new PlatformApiError("RUNTIME_COMMAND_STATE_CONFLICT", 409)
      }
      if (record.delivered_at === null) {
        record.delivered_at = now()
        record.updated_at = record.delivered_at
      }
      return clone(record)
    },
    recordGatewayReleaseReport(input) {
      return recordReport(input.tenantId, input.report)
    },
    async getLatestGatewayReleaseObserved(input) {
      if (input.runtimeKind !== undefined && input.runtimeKind !== "GATEWAY") return null
      return clone(observations.get(runtimeKey(input.tenantId, input.runtimeId)) ?? null)
    },
    async listGatewayReleaseReportHistory(input) {
      if (input.runtimeKind !== undefined && input.runtimeKind !== "GATEWAY") return []
      return clone(history.get(runtimeKey(input.tenantId, input.runtimeId)) ?? [])
    },
  }
}
