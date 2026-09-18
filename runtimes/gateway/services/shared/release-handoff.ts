import {
  GATEWAY_RELEASE_REFERENCE_SCHEMA_VERSION,
  isGatewayReleaseReference,
  type GatewayReleaseReference,
} from "../../../../packages/protocol/src/runtime-command"

const TRUSTED_RELEASE_ID_HEADER = "x-genio-trusted-release-id"
const TRUSTED_RELEASE_GATEWAY_HEADER = "x-genio-trusted-release-gateway-id"
const TRUSTED_RELEASE_HEAD_REVISION_HEADER =
  "x-genio-trusted-release-head-revision"
const TRUSTED_RELEASE_PACKAGE_DIGEST_HEADER =
  "x-genio-trusted-release-package-digest"
const TRUSTED_RELEASE_PROJECTION_COUNT_HEADER =
  "x-genio-trusted-release-projection-count"

export const TRUSTED_RELEASE_HEADERS = [
  TRUSTED_RELEASE_ID_HEADER,
  TRUSTED_RELEASE_GATEWAY_HEADER,
  TRUSTED_RELEASE_HEAD_REVISION_HEADER,
  TRUSTED_RELEASE_PACKAGE_DIGEST_HEADER,
  TRUSTED_RELEASE_PROJECTION_COUNT_HEADER,
] as const

export function trustedReleaseHeaderEntries(
  release: GatewayReleaseReference,
): ReadonlyArray<readonly [string, string]> {
  if (!isGatewayReleaseReference(release)) {
    throw new Error("trusted Gateway release reference is invalid")
  }
  return [
    [TRUSTED_RELEASE_ID_HEADER, release.release_id],
    [TRUSTED_RELEASE_GATEWAY_HEADER, release.gateway_id],
    [TRUSTED_RELEASE_HEAD_REVISION_HEADER, String(release.head_revision)],
    [TRUSTED_RELEASE_PACKAGE_DIGEST_HEADER, release.package_digest],
    [TRUSTED_RELEASE_PROJECTION_COUNT_HEADER, String(release.projection_count)],
  ]
}

function canonicalInteger(value: string, allowZero: boolean): number {
  const pattern = allowZero ? /^(0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/
  if (!pattern.test(value)) throw new Error("trusted Gateway release integer is invalid")
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("trusted Gateway release integer is invalid")
  }
  return parsed
}

export function trustedReleaseFromHeaders(
  required: (name: string) => string,
): GatewayReleaseReference {
  const value: GatewayReleaseReference = {
    schema_version: GATEWAY_RELEASE_REFERENCE_SCHEMA_VERSION,
    release_id: required(TRUSTED_RELEASE_ID_HEADER),
    gateway_id: required(TRUSTED_RELEASE_GATEWAY_HEADER),
    head_revision: canonicalInteger(
      required(TRUSTED_RELEASE_HEAD_REVISION_HEADER),
      false,
    ),
    package_digest: required(TRUSTED_RELEASE_PACKAGE_DIGEST_HEADER),
    projection_count: canonicalInteger(
      required(TRUSTED_RELEASE_PROJECTION_COUNT_HEADER),
      true,
    ),
  }
  if (!isGatewayReleaseReference(value)) {
    throw new Error("trusted Gateway release reference is invalid")
  }
  return value
}

/**
 * Sidecars are addressed through Gateway Group Services and may run in
 * different replicas. Their runtime-bound package digests therefore differ,
 * while the content-addressed release identity must remain the same.
 */
export function gatewayGroupReleaseReferencesEqual(
  left: GatewayReleaseReference,
  right: GatewayReleaseReference,
): boolean {
  return (
    left.schema_version === right.schema_version &&
    left.release_id === right.release_id &&
    left.gateway_id === right.gateway_id &&
    left.head_revision === right.head_revision &&
    left.projection_count === right.projection_count
  )
}
