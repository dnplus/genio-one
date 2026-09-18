import assert from "node:assert/strict"
import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto"
import test from "node:test"

import { PlatformApiError } from "../src/capabilities/errors"
import { createDurableEd25519Signer } from "../src/capabilities/gateway-projection/signer"

function privateKeyPem(): string {
  return generateKeyPairSync("ed25519").privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString()
}

test("durable signer derives a stable public-key id and signs deterministic bytes", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  const publicDer = publicKey.export({ type: "spki", format: "der" })
  const expectedKeyId = createHash("sha256").update(publicDer).digest("hex")
  const payload = new TextEncoder().encode('{"revision":7,"tenant_id":"tenant-acme"}')

  const first = createDurableEd25519Signer({ privateKeyPem: pem })
  const second = createDurableEd25519Signer({ privateKeyPem: Buffer.from(pem) })

  assert.equal(first.algorithm, "Ed25519")
  assert.equal(first.keyId, expectedKeyId)
  assert.equal(first.keyId, second.keyId)
  assert.equal(await first.sign(payload), await second.sign(payload))
  const signature = await first.sign(payload)
  assert.equal(
    verify(null, Buffer.from(payload), createPublicKey(first.publicKeyPem), Buffer.from(signature, "base64url")),
    true,
  )
})

test("durable signer accepts an explicit key id override without changing key material", () => {
  const pem = privateKeyPem()
  const signer = createDurableEd25519Signer({ privateKeyPem: pem, keyId: "gateway-key-2026-08" })

  assert.equal(signer.keyId, "gateway-key-2026-08")
  assert.match(signer.publicKeyPem, /BEGIN PUBLIC KEY/)
})

test("durable signer fails closed for missing, malformed, and non-Ed25519 keys", () => {
  assert.throws(
    () => createDurableEd25519Signer({ privateKeyPem: "" }),
    (error: unknown) =>
      error instanceof PlatformApiError && error.code === "GATEWAY_PROJECTION_SIGNER_REQUIRED",
  )
  assert.throws(
    () => createDurableEd25519Signer({ privateKeyPem: "not-a-pem-key" }),
    (error: unknown) =>
      error instanceof PlatformApiError && error.code === "INVALID_GATEWAY_PROJECTION_SIGNER",
  )

  const rsaPem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
    .export({ type: "pkcs1", format: "pem" })
    .toString()
  assert.throws(
    () => createDurableEd25519Signer({ privateKeyPem: rsaPem }),
    (error: unknown) =>
      error instanceof PlatformApiError && error.code === "INVALID_GATEWAY_PROJECTION_SIGNER",
  )
  assert.throws(
    () => createDurableEd25519Signer({ privateKeyPem: privateKeyPem(), keyId: " " }),
    (error: unknown) =>
      error instanceof PlatformApiError && error.code === "INVALID_GATEWAY_PROJECTION_SIGNER",
  )
})
