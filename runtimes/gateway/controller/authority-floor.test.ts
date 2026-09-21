import assert from "node:assert/strict"
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import type { CompiledAuthorizationBundle } from "@genioone/protocol/authorization"
import type { GatewayReleasePackage } from "../../../apps/platform/platform-api/src/capabilities/gateway-policy-release/package"
import type { GatewayRuntimeCommand } from "@genioone/protocol/runtime-command"
import { createGatewayRuntimeFileAuthorityFloor } from "./authority-floor"

function compactJws(payload: unknown, keyId: string, privateKey: KeyObject): string {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: keyId })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const signature = sign(null, Buffer.from(`${header}.${body}`), privateKey).toString("base64url")
  return `${header}.${body}.${signature}`
}

test("file authority floor verifies a desired bundle and preserves revoked entitlements across generations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "genio-one-authority-floor-"))
  try {
    const keys = generateKeyPairSync("ed25519")
    const keyId = "policy-key"
    const keyRing = {
      schema_version: 1 as const,
      keys: [{
        key_id: keyId,
        public_key_pem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      }],
    }
    const bundle: CompiledAuthorizationBundle = {
      schema_version: 1,
      tenant_id: "tenant-acme",
      revision: "revision-7",
      policy_version: "policy-7",
      issued_at: 1,
      expires_at: 10_000,
      rules: [],
      revoked_entitlement_ids: ["entitlement-revoked"],
    }
    const release = {
      tenant_id: "tenant-acme",
      head_revision: 7,
      authorization_bundle_jws: compactJws(bundle, keyId, keys.privateKey),
      enforcement_verification_keys_json: JSON.stringify(keyRing),
    } as GatewayReleasePackage
    const command = { tenant_id: "tenant-acme" } as GatewayRuntimeCommand
    const path = join(directory, "authority-floor.json")
    const store = createGatewayRuntimeFileAuthorityFloor(path)

    await store.advance({ command, release })
    const persisted = JSON.parse(await readFile(path, "utf8"))

    assert.equal(persisted.generation, 7)
    assert.deepEqual(persisted.revoked_entitlement_ids, ["entitlement-revoked"])
    assert.deepEqual(await store.load(), persisted)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
