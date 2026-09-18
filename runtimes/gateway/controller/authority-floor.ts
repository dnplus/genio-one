import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import { verifyAuthorizationBundle } from "../services/authorizer/signed-bundle"
import { advanceAuthorityFloor, parseAuthorityFloor, type AuthorityFloor } from "../services/shared/authority-floor"
import type { VerificationKeyRing } from "../../../packages/protocol/src/compact-jws"
import type { GatewayRuntimeAuthorityFloorStore } from "./runtime"

export function createGatewayRuntimeFileAuthorityFloor(path: string): GatewayRuntimeAuthorityFloorStore {
  const candidatePath = `${path}.candidate`

  async function load(): Promise<AuthorityFloor | null> {
    try {
      return parseAuthorityFloor(JSON.parse(await readFile(path, "utf8")))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw error
    }
  }

  return {
    async advance({ command, release }) {
      let keyRing: VerificationKeyRing
      try {
        keyRing = JSON.parse(release.enforcement_verification_keys_json) as VerificationKeyRing
      } catch {
        throw new Error("authority floor verification keyring is invalid")
      }
      const bundle = verifyAuthorizationBundle(release.authorization_bundle_jws, keyRing)
      if (bundle.tenant_id !== command.tenant_id || release.tenant_id !== command.tenant_id) {
        throw new Error("authority floor release tenant mismatch")
      }
      const next = advanceAuthorityFloor({
        current: await load(),
        tenantId: command.tenant_id,
        generation: release.head_revision,
        revokedEntitlementIds: bundle.revoked_entitlement_ids ?? [],
      })
      await mkdir(dirname(path), { recursive: true })
      await writeFile(candidatePath, `${JSON.stringify(next)}\n`, { encoding: "utf8", mode: 0o600 })
      await rename(candidatePath, path)
      return next
    },
    load,
  }
}
