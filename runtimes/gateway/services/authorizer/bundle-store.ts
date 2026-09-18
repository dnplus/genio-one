import type { CompiledAuthorizationBundle } from "../../../../packages/protocol/src/authorization"
import { readFile } from "node:fs/promises"
import {
  FilePolicyReleaseLoader,
  type PolicyReleaseObservation,
  type PolicyReleaseLoaderOptions,
} from "../shared/policy-release"
import type { GatewayReleaseReference } from "../../../../packages/protocol/src/runtime-command"
import type { GatewayRoutingArtifact } from "../shared/gateway-routing-artifact"
import { applyAuthorityFloor, parseAuthorityFloor } from "../shared/authority-floor"

export type AuthorizationBundleStoreOptions = PolicyReleaseLoaderOptions & {
  authorityFloorPath?: string
}

export interface AuthorizationBundleSnapshot {
  bundle: CompiledAuthorizationBundle
  releaseReference: GatewayReleaseReference
  routingArtifact: GatewayRoutingArtifact
}

export interface AuthorizationBundleSource {
  current(): Promise<AuthorizationBundleSnapshot>
}

/**
 * Authorizer view of the shared, atomically published policy release.
 * Authorization and processor artifacts are validated together by the shared
 * loader, so this adapter cannot accidentally consume a different release.
 */
export class FileAuthorizationBundleStore implements AuthorizationBundleSource {
  private readonly loader: FilePolicyReleaseLoader
  private readonly authorityFloorPath?: string

  constructor(options: AuthorizationBundleStoreOptions) {
    this.loader = new FilePolicyReleaseLoader(options)
    this.authorityFloorPath = options.authorityFloorPath
  }

  async current(): Promise<AuthorizationBundleSnapshot> {
    const release = await this.loader.current()
    const floor = this.authorityFloorPath
      ? parseAuthorityFloor(JSON.parse(await readFile(this.authorityFloorPath, "utf8")))
      : null
    if (floor && floor.tenant_id !== release.authorizationBundle.tenant_id) {
      throw new Error("authority floor tenant mismatch")
    }
    return {
      bundle: floor
        ? { ...release.authorizationBundle, rules: applyAuthorityFloor(release.authorizationBundle.rules, floor) }
        : release.authorizationBundle,
      releaseReference: release.releaseReference,
      routingArtifact: release.gatewayRoutingArtifact,
    }
  }

  async releaseObservation(): Promise<PolicyReleaseObservation> {
    return this.loader.releaseObservation()
  }
}
