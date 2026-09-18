import type { GatewayProjectionRepository } from "../gateway-projection/contract"
import { PlatformApiError } from "../errors"
import type { GatewayPolicyReleaseStore } from "./module"
import {
  buildGatewayReleasePackage,
  type GatewayReleasePackage,
} from "./package"

export interface GatewayReleasePackageSourceInput {
  tenantId: string
  runtimeId: string
  releaseId: string
  /** The CAS head revision captured by the immutable runtime command. */
  headRevision: number
}

export interface GatewayReleasePackageSource {
  getPackage(input: GatewayReleasePackageSourceInput): Promise<GatewayReleasePackage | null>
}

export interface GatewayReleasePackageSourceOptions {
  releases: GatewayPolicyReleaseStore
  projections: GatewayProjectionRepository
}

function requireIdentifier(value: string, label: string): void {
  if (!value.trim() || value.trim() !== value || /[\u0000\r\n]/.test(value)) {
    throw new PlatformApiError("GATEWAY_RELEASE_PACKAGE_INPUT_INVALID", 422, `${label} is invalid`)
  }
}

/**
 * Rehydrate one immutable, target-specific package from normalized release
 * state. The caller supplies the head revision captured by its command; the
 * current Gateway head is deliberately not consulted, so pending commands
 * remain fetchable after a later release advances the head.
 */
export function createGatewayReleasePackageSource(
  options: GatewayReleasePackageSourceOptions,
): GatewayReleasePackageSource {
  return {
    async getPackage(input) {
      requireIdentifier(input.tenantId, "tenantId")
      requireIdentifier(input.runtimeId, "runtimeId")
      requireIdentifier(input.releaseId, "releaseId")
      if (!Number.isSafeInteger(input.headRevision) || input.headRevision < 1) {
        throw new PlatformApiError("GATEWAY_RELEASE_PACKAGE_INPUT_INVALID", 422)
      }

      const [release, manifest] = await Promise.all([
        options.releases.get({ tenantId: input.tenantId, releaseId: input.releaseId }),
        options.releases.getManifest({
          tenantId: input.tenantId,
          releaseId: input.releaseId,
          runtimeId: input.runtimeId,
        }),
      ])
      if (!release || !manifest) return null
      if (
        release.tenant_id !== input.tenantId ||
        manifest.tenant_id !== input.tenantId ||
        manifest.runtime_id !== input.runtimeId ||
        manifest.release_id !== input.releaseId ||
        manifest.gateway_id !== release.gateway_id
      ) {
        throw new PlatformApiError("GATEWAY_RELEASE_PACKAGE_DATA_INVALID", 500)
      }

      const projections = await Promise.all(release.projections.map(async (reference) => {
        const projection = await options.projections.getProjection({
          tenantId: input.tenantId,
          projectionId: reference.projection_id,
        })
        if (!projection) {
          throw new PlatformApiError(
            "GATEWAY_RELEASE_PACKAGE_PROJECTION_MISSING",
            500,
            `Projection ${reference.projection_id} is missing from an immutable Gateway release`,
          )
        }
        return projection
      }))

      try {
        return buildGatewayReleasePackage({
          saved: {
            release,
            target: {
              tenant_id: input.tenantId,
              runtime_id: input.runtimeId,
              gateway_id: release.gateway_id,
            },
            manifest,
            head: {
              tenant_id: input.tenantId,
              gateway_id: release.gateway_id,
              release_id: input.releaseId,
              content_digest: release.content_digest,
              head_revision: input.headRevision,
              updated_at: release.updated_at,
            },
          },
          projections,
        }).package
      } catch (error) {
        if (error instanceof PlatformApiError) throw error
        throw new PlatformApiError(
          "GATEWAY_RELEASE_PACKAGE_DATA_INVALID",
          500,
          error instanceof Error ? error.message : "Gateway release package is invalid",
        )
      }
    },
  }
}
