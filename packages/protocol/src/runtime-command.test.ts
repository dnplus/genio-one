import assert from "node:assert/strict"
import { generateKeyPairSync } from "node:crypto"
import test from "node:test"

import { createDurableEd25519Signer } from "../../../apps/platform/platform-api/src/capabilities/gateway-projection/signer"
import { signGatewayReleaseCommand } from "../../../apps/platform/platform-api/src/capabilities/runtime-control/gateway-release-integrity"
import { verifyGatewayRuntimeCommand } from "./runtime-command"

function signer(keyId: string) {
  const { privateKey } = generateKeyPairSync("ed25519")
  return createDurableEd25519Signer({
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    keyId,
  })
}

test("gateway sidecars verify the Platform-signed runtime release command", async () => {
  const platform = signer("platform-command-1")
  const command = await signGatewayReleaseCommand({
    tenantId: "tenant-ai",
    runtimeId: "gateway-runtime-1",
    commandId: "command-release-7",
    release: {
      schema_version: "genio.one.gateway-release-ref.v1",
      release_id: "release-7",
      gateway_id: "ai-gateway",
      head_revision: 7,
      package_digest: "a".repeat(64),
      projection_count: 2,
    },
    signer: platform,
  })
  const keyRing = {
    schema_version: 1 as const,
    keys: [{ key_id: platform.keyId, public_key_pem: platform.publicKeyPem }],
  }

  assert.deepEqual(verifyGatewayRuntimeCommand(command, keyRing), command)
  assert.throws(
    () => verifyGatewayRuntimeCommand({ ...command, extra: true }, keyRing),
    /command is invalid/,
  )
  assert.throws(
    () =>
      verifyGatewayRuntimeCommand(
        {
          ...command,
          desired_release: {
            ...command.desired_release,
            package_digest: "b".repeat(64),
          },
        },
        keyRing,
      ),
    /digest does not match/,
  )
  const other = signer("platform-command-2")
  assert.throws(
    () =>
      verifyGatewayRuntimeCommand(command, {
        schema_version: 1,
        keys: [{ key_id: other.keyId, public_key_pem: other.publicKeyPem }],
      }),
    /signing key is unknown/,
  )
})
