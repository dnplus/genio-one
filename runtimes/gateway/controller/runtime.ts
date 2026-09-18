import { randomUUID } from "node:crypto"

import { Check, Errors } from "typebox/value"

import {
  GatewayReleasePackageSchema,
  gatewayReleasePackageDigest,
  type GatewayReleasePackage,
} from "../../../apps/platform/platform-api/src/capabilities/gateway-policy-release/package"
import {
  RUNTIME_PROTOCOL_SCHEMA_VERSION,
  GatewayRuntimeReportSchema,
  type GatewayObservedState,
  type GatewayRuntimeReport,
} from "../../../packages/protocol/src/gateway-release"
import {
  runtimeProtocolDigest,
  runtimeProtocolSignaturePayload,
} from "../../../apps/platform/platform-api/src/capabilities/runtime-control/gateway-release-integrity"
import {
  gatewayReleaseReferencesEqual,
  verifyGatewayRuntimeCommand,
  type GatewayRuntimeCommand,
} from "../../../packages/protocol/src/runtime-command"
import type { VerificationKeyRing } from "../../../packages/protocol/src/compact-jws"

export interface GatewayRuntimeSigner {
  readonly keyId: string
  sign(payload: Uint8Array): Promise<string> | string
}

export interface GatewayReleaseApplier {
  apply(input: {
    command: GatewayRuntimeCommand
    release: GatewayReleasePackage
  }): Promise<GatewayObservedState["components"]>
}

export interface GatewayRuntimeOptions {
  deployment: {
    tenantId: string
    runtimeId: string
    gatewayId: string
  }
  commandKeyRing: VerificationKeyRing
  signer: GatewayRuntimeSigner
  fetchRelease(command: GatewayRuntimeCommand): Promise<unknown>
  applier: GatewayReleaseApplier
  authorityFloor: GatewayRuntimeAuthorityFloorStore
  state?: GatewayRuntimeStateStore
}

export interface GatewayRuntimeState {
  command: GatewayRuntimeCommand
  release: GatewayReleasePackage
}

export interface GatewayRuntimeStateStore {
  load(): Promise<unknown | null>
  save(state: GatewayRuntimeState): Promise<void>
}

export interface GatewayRuntimeAuthorityFloorStore {
  advance(input: GatewayRuntimeState): Promise<unknown>
  load(): Promise<unknown | null>
}

export interface GatewayRuntime {
  applyCommand(command: unknown): Promise<GatewayRuntimeReport>
  reportCurrent(): Promise<GatewayRuntimeReport | null>
  restore(): Promise<boolean>
}

export class GatewayRuntimeDeploymentBindingError extends Error {
  constructor() {
    super("Gateway Runtime command does not match its Installation/Site deployment binding")
    this.name = "GatewayRuntimeDeploymentBindingError"
  }
}

function assertDeploymentBinding(
  command: GatewayRuntimeCommand,
  deployment: GatewayRuntimeOptions["deployment"],
): void {
  if (
    command.tenant_id !== deployment.tenantId ||
    command.runtime_id !== deployment.runtimeId ||
    command.desired_release.gateway_id !== deployment.gatewayId
  ) {
    throw new GatewayRuntimeDeploymentBindingError()
  }
}

function packageWithoutDigest(
  release: GatewayReleasePackage,
): Omit<GatewayReleasePackage, "package_digest"> {
  const value = { ...release }
  delete (value as Partial<GatewayReleasePackage>).package_digest
  return value
}

function requireRelease(
  value: unknown,
  command: GatewayRuntimeCommand,
): GatewayReleasePackage {
  if (!Check(GatewayReleasePackageSchema, value)) {
    throw new Error("Gateway release package does not satisfy the contract")
  }
  const release = value as GatewayReleasePackage
  const reference = command.desired_release
  if (
    release.tenant_id !== command.tenant_id ||
    release.runtime_id !== command.runtime_id ||
    release.gateway_id !== reference.gateway_id ||
    release.release_id !== reference.release_id ||
    release.head_revision !== reference.head_revision ||
    release.projection_count !== reference.projection_count ||
    release.projections.length !== reference.projection_count ||
    release.package_digest !== reference.package_digest
  ) {
    throw new Error("Gateway release package does not match the command")
  }
  const digest = gatewayReleasePackageDigest(packageWithoutDigest(release))
  if (digest !== release.package_digest) {
    throw new Error("Gateway release package digest does not match")
  }
  return release
}

async function signedReport(input: {
  command: GatewayRuntimeCommand
  observed: GatewayObservedState
  signer: GatewayRuntimeSigner
}): Promise<GatewayRuntimeReport> {
  const reportId = randomUUID()
  const unsigned = {
    schema_version: RUNTIME_PROTOCOL_SCHEMA_VERSION,
    message_type: "REPORT" as const,
    tenant_id: input.command.tenant_id,
    runtime_id: input.command.runtime_id,
    report_id: reportId,
    command_id: input.command.command_id,
    revision: input.command.revision,
    digest: "0".repeat(64),
    signature: {
      algorithm: "Ed25519" as const,
      key_id: input.signer.keyId,
      value: "placeholder",
    },
    runtime_kind: "GATEWAY" as const,
    observed_status: input.observed,
  }
  const digest = runtimeProtocolDigest(unsigned)
  const digestBearing = { ...unsigned, digest }
  const signature = await input.signer.sign(
    new TextEncoder().encode(runtimeProtocolSignaturePayload(digestBearing)),
  )
  const report: GatewayRuntimeReport = {
    ...digestBearing,
    signature: {
      algorithm: "Ed25519",
      key_id: input.signer.keyId,
      value: signature,
    },
  }
  if (!Check(GatewayRuntimeReportSchema, report)) {
    const issue = [...Errors(GatewayRuntimeReportSchema, report)][0]
    const issuePath = issue && "instancePath" in issue ? String(issue.instancePath) : "/"
    throw new Error(
      `Gateway Runtime report contract invalid at ${issuePath}: ${issue?.message ?? "unknown error"}`,
    )
  }
  return report
}

function runtimeErrorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : "Gateway release apply failed"
  return value.replace(/[\u0000\r\n]+/g, " ").slice(0, 2_048)
}

/**
 * The complete Gateway Runtime interface for the first vertical slice.
 *
 * It accepts one signed desired release and returns one signed observation.
 * Transport, persistence and the local/Kubernetes apply mechanism remain
 * adapters behind this interface.
 */
export function createGatewayRuntime(options: GatewayRuntimeOptions): GatewayRuntime {
  let currentState: GatewayRuntimeState | undefined
  let currentComponents: NonNullable<GatewayObservedState["components"]> | undefined

  async function restoreState(value: unknown): Promise<GatewayRuntimeState> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Gateway Runtime current state is invalid")
    }
    const record = value as Record<string, unknown>
    if (Object.keys(record).length !== 2 || !("command" in record) || !("release" in record)) {
      throw new Error("Gateway Runtime current state is invalid")
    }
    const command = verifyGatewayRuntimeCommand(record.command, options.commandKeyRing)
    assertDeploymentBinding(command, options.deployment)
    const release = requireRelease(record.release, command)
    return { command, release }
  }

  return {
    async restore() {
      if (!options.state) return false
      const value = await options.state.load()
      if (value === null) return false
      const current = await restoreState(value)
      await options.authorityFloor.advance(current)
      const components = await options.applier.apply(current)
      if (!components?.length) {
        throw new Error("Gateway Runtime restore did not observe any ready components")
      }
      currentState = current
      currentComponents = structuredClone(components)
      return true
    },
    async applyCommand(value) {
      const command = verifyGatewayRuntimeCommand(value, options.commandKeyRing)
      assertDeploymentBinding(command, options.deployment)
      let observed: GatewayObservedState
      try {
        if (currentState) {
          const currentReference = currentState.command.desired_release
          const desiredReference = command.desired_release
          if (desiredReference.head_revision < currentReference.head_revision) {
            throw new Error(
              `Gateway release revision ${desiredReference.head_revision} is older than applied revision ${currentReference.head_revision}`,
            )
          }
          if (desiredReference.head_revision === currentReference.head_revision) {
            if (!gatewayReleaseReferencesEqual(desiredReference, currentReference)) {
              throw new Error(
                `Gateway release revision ${desiredReference.head_revision} conflicts with the applied release`,
              )
            }
            if (!currentComponents?.length) {
              throw new Error("Gateway Runtime has no ready component observation for the applied release")
            }
            return signedReport({
              command,
              observed: {
                state: "READY",
                applied_release: structuredClone(currentReference),
                components: structuredClone(currentComponents),
              },
              signer: options.signer,
            })
          }
        }
        const release = requireRelease(await options.fetchRelease(command), command)
        await options.authorityFloor.advance({ command, release })
        const components = await options.applier.apply({ command, release })
        if (!components?.length) {
          throw new Error("Gateway Runtime apply did not observe any ready components")
        }
        await options.state?.save({ command, release })
        currentState = { command, release }
        currentComponents = structuredClone(components)
        observed = {
          state: "READY",
          applied_release: structuredClone(command.desired_release),
          components,
        }
      } catch (error) {
        observed = {
          state: "DEGRADED",
          ...(currentState
            ? { applied_release: structuredClone(currentState.command.desired_release) }
            : {}),
          error: {
            code: "GATEWAY_RELEASE_APPLY_FAILED",
            message: runtimeErrorMessage(error),
          },
        }
      }
      const report = await signedReport({ command, observed, signer: options.signer })
      if (
        report.observed_status.state === "READY" &&
        (!report.observed_status.applied_release ||
          !gatewayReleaseReferencesEqual(
            report.observed_status.applied_release,
            command.desired_release,
          ))
      ) {
        throw new Error("Gateway Runtime produced an invalid ready observation")
      }
      return report
    },
    async reportCurrent() {
      if (!currentState || !currentComponents?.length) return null
      return signedReport({
        command: currentState.command,
        observed: {
          state: "READY",
          applied_release: structuredClone(currentState.command.desired_release),
          components: structuredClone(currentComponents),
        },
        signer: options.signer,
      })
    },
  }
}
