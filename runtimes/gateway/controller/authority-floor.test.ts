import assert from "node:assert/strict"
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import type { CompiledAuthorizationBundle } from "@genioone/protocol/authorization"
import type { GatewayReleasePackage } from "../../../apps/platform/platform-api/src/capabilities/gateway-policy-release/package"
import type { GatewayRuntimeCommand } from "@genioone/protocol/runtime-command"
import { createGatewayRuntimeFileAuthorityFloor } from "./authority-floor"
import { parseAuthorityFloor } from "../services/shared/authority-floor"

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


async function withFloor(run: (fixture: {
  path: string
  store: ReturnType<typeof createGatewayRuntimeFileAuthorityFloor>
  command: GatewayRuntimeCommand
  release: GatewayReleasePackage
  releaseFor: (generation: number, revoked?: string[], tenant?: string) => GatewayReleasePackage
}) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "genio-one-floor-boundary-"))
  try {
    const keys = generateKeyPairSync("ed25519")
    const keyRing = { schema_version: 1, keys: [{ key_id: "ephemeral-key", public_key_pem: keys.publicKey.export({ type: "spki", format: "pem" }).toString() }] }
    const releaseFor = (generation: number, revoked = ["entitlement-original"], tenant = "tenant-acme") => ({
      tenant_id: tenant,
      head_revision: generation,
      authorization_bundle_jws: compactJws({ schema_version: 1, tenant_id: tenant, revision: `revision-${generation}`, policy_version: `policy-${generation}`, issued_at: 1, expires_at: 10000, rules: [], revoked_entitlement_ids: revoked }, "ephemeral-key", keys.privateKey),
      enforcement_verification_keys_json: JSON.stringify(keyRing),
    } as GatewayReleasePackage)
    const path = join(directory, "floor.json")
    await run({ path, store: createGatewayRuntimeFileAuthorityFloor(path), command: { tenant_id: "tenant-acme" } as GatewayRuntimeCommand, release: releaseFor(7), releaseFor })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test("missing authority floor loads as null without creating a file", async () => {
  await withFloor(async ({ store, path }) => {
    assert.equal(await store.load(), null)
    await assert.rejects(readFile(path), { code: "ENOENT" })
  })
})

for (const mismatch of ["command", "release", "bundle"] as const) {
  test(`a mismatched ${mismatch} tenant rejects advancement and preserves persisted bytes`, async () => {
    await withFloor(async ({ store, path, command, release, releaseFor }) => {
      await store.advance({ command, release })
      const before = await readFile(path)
      const next = releaseFor(8)
      const mismatchedRelease = mismatch === "bundle"
        ? { ...releaseFor(8, [], "other-tenant"), tenant_id: "tenant-acme" }
        : mismatch === "release" ? { ...next, tenant_id: "other-tenant" } : next
      await assert.rejects(store.advance({ command: mismatch === "command" ? { ...command, tenant_id: "other-tenant" } : command, release: mismatchedRelease }), /release tenant mismatch/)
      assert.deepEqual(await readFile(path), before)
    })
  })
}

for (const invalid of ["signature", "unknown-key", "keyring-json"] as const) {
  test(`invalid ${invalid} rejects advancement without overwriting the authority floor`, async () => {
    await withFloor(async ({ store, path, command, release, releaseFor }) => {
      await store.advance({ command, release })
      const before = await readFile(path)
      const next = releaseFor(8)
      let pattern: RegExp
      if (invalid === "signature") {
        const [header, payload, signature] = next.authorization_bundle_jws.split(".")
        const bytes = Buffer.from(signature!, "base64url")
        bytes[0] = bytes[0]! ^ 1
        next.authorization_bundle_jws = `${header}.${payload}.${bytes.toString("base64url")}`
        pattern = /signature is invalid/
      } else if (invalid === "unknown-key") {
        const ring = JSON.parse(next.enforcement_verification_keys_json)
        ring.keys[0].key_id = "unknown-key"
        next.enforcement_verification_keys_json = JSON.stringify(ring)
        pattern = /signing key is unknown/
      } else {
        next.enforcement_verification_keys_json = "{invalid JSON"
        pattern = /authority floor verification keyring is invalid/
      }
      await assert.rejects(store.advance({ command, release: next }), pattern)
      assert.deepEqual(await readFile(path), before)
    })
  })
}

test("a restarted store rejects regressed generations and retains revocations through replay and advancement", async () => {
  await withFloor(async ({ store, path, command, release, releaseFor }) => {
    await store.advance({ command, release })
    const restarted = createGatewayRuntimeFileAuthorityFloor(path)
    assert.deepEqual(await restarted.load(), await store.load())
    const before = await readFile(path)
    await assert.rejects(restarted.advance({ command, release: releaseFor(6, []) }), /cannot regress/)
    assert.deepEqual(await readFile(path), before)
    const replay = parseAuthorityFloor(await restarted.advance({ command, release: releaseFor(7, []) }))
    assert.deepEqual(replay.revoked_entitlement_ids, ["entitlement-original"])
    const next = parseAuthorityFloor(await restarted.advance({ command, release: releaseFor(8, ["entitlement-new"]) }))
    assert.equal(next.generation, 8)
    assert.deepEqual(next.revoked_entitlement_ids, ["entitlement-new", "entitlement-original"])
    assert.deepEqual(await createGatewayRuntimeFileAuthorityFloor(path).load(), next)
  })
})

for (const corruption of ["invalid-json", "non-canonical", "invalid-floor"] as const) {
  test(`persisted ${corruption} is refused on load and advance without overwriting evidence`, async () => {
    await withFloor(async ({ store, path, command, release }) => {
      await store.advance({ command, release })
      const floor = JSON.parse(await readFile(path, "utf8"))
      const corrupt = corruption === "invalid-json" ? "{broken" : JSON.stringify({ ...floor, ...(corruption === "non-canonical" ? { revoked_entitlement_ids: ["z", "a"] } : { generation: -1 }) })
      await writeFile(path, corrupt)
      const before = await readFile(path)
      const restarted = createGatewayRuntimeFileAuthorityFloor(path)
      await assert.rejects(restarted.load())
      await assert.rejects(restarted.advance({ command, release }))
      assert.deepEqual(await readFile(path), before)
    })
  })
}
