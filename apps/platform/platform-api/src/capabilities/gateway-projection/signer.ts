import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto"
import type { KeyObject } from "node:crypto"

import { PlatformApiError } from "../errors"
import type { GatewayProjectionSigner } from "./contract"

/**
 * The platform receives the key material from an explicit secret/key-store
 * adapter. This module deliberately does not read environment variables or
 * filesystem paths so key loading remains an application-owned boundary.
 * `privateKeyPem` may therefore be the contents read from a mounted key file.
 */
export interface DurableEd25519SignerOptions {
  privateKeyPem: string | Uint8Array
  /** Optional stable identifier used when rotating keys under a known kid. */
  keyId?: string
}

export interface DurableEd25519Signer extends GatewayProjectionSigner {
  /** Public material may be placed in the runtime verification key ring. */
  readonly publicKeyPem: string
}

function signerError(code: "GATEWAY_PROJECTION_SIGNER_REQUIRED" | "INVALID_GATEWAY_PROJECTION_SIGNER", message: string): PlatformApiError {
  return new PlatformApiError(code, 500, message)
}

function keyMaterial(value: string | Uint8Array): string | Buffer {
  if (typeof value === "string") {
    if (!value.trim()) {
      throw signerError(
        "GATEWAY_PROJECTION_SIGNER_REQUIRED",
        "A durable Ed25519 private key is required",
      )
    }
    return value
  }

  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw signerError(
      "GATEWAY_PROJECTION_SIGNER_REQUIRED",
      "A durable Ed25519 private key is required",
    )
  }
  return Buffer.from(value)
}

function loadPrivateKey(value: string | Uint8Array): KeyObject {
  try {
    const privateKey = createPrivateKey(keyMaterial(value))
    if (privateKey.asymmetricKeyType !== "ed25519") {
      throw signerError(
        "INVALID_GATEWAY_PROJECTION_SIGNER",
        "The gateway projection signer must use an Ed25519 private key",
      )
    }
    return privateKey
  } catch (error) {
    if (error instanceof PlatformApiError) throw error
    throw signerError(
      "INVALID_GATEWAY_PROJECTION_SIGNER",
      "The gateway projection signer private key is invalid",
    )
  }
}

function derivePublicKey(privateKey: KeyObject): {
  key: KeyObject
  der: Buffer
  pem: string
} {
  try {
    const key = createPublicKey(privateKey)
    if (key.asymmetricKeyType !== "ed25519") {
      throw signerError(
        "INVALID_GATEWAY_PROJECTION_SIGNER",
        "The gateway projection signer public key must use Ed25519",
      )
    }
    const der = key.export({ type: "spki", format: "der" })
    if (!Buffer.isBuffer(der)) {
      throw signerError(
        "INVALID_GATEWAY_PROJECTION_SIGNER",
        "The gateway projection signer public key could not be exported",
      )
    }
    return {
      key,
      der,
      pem: key.export({ type: "spki", format: "pem" }).toString(),
    }
  } catch (error) {
    if (error instanceof PlatformApiError) throw error
    throw signerError(
      "INVALID_GATEWAY_PROJECTION_SIGNER",
      "The gateway projection signer public key is invalid",
    )
  }
}

function resolveKeyId(derivedKeyId: string, override: string | undefined): string {
  if (override === undefined) return derivedKeyId
  if (!override.trim() || override !== override.trim() || override.length > 256) {
    throw signerError(
      "INVALID_GATEWAY_PROJECTION_SIGNER",
      "The gateway projection signer key id is invalid",
    )
  }
  return override
}

/**
 * Creates a restart-stable Ed25519 projection signer from explicit PEM
 * contents. Ed25519 signatures are deterministic for the same key and byte
 * sequence, so the resulting projection signature is stable across process
 * restarts when the same durable key is supplied.
 */
export function createDurableEd25519Signer(
  options: DurableEd25519SignerOptions,
): DurableEd25519Signer {
  if (!options || typeof options !== "object" || !("privateKeyPem" in options)) {
    throw signerError(
      "GATEWAY_PROJECTION_SIGNER_REQUIRED",
      "A durable Ed25519 private key is required",
    )
  }

  const privateKey = loadPrivateKey(options.privateKeyPem)
  const publicKey = derivePublicKey(privateKey)
  const derivedKeyId = createHash("sha256").update(publicKey.der).digest("hex")
  const keyId = resolveKeyId(derivedKeyId, options.keyId)

  return Object.freeze({
    algorithm: "Ed25519" as const,
    keyId,
    publicKeyPem: publicKey.pem,
    sign(payload: Uint8Array): string {
      if (!(payload instanceof Uint8Array)) {
        throw signerError(
          "INVALID_GATEWAY_PROJECTION_SIGNER",
          "The gateway projection signer payload must be bytes",
        )
      }
      return sign(null, Buffer.from(payload), privateKey).toString("base64url")
    },
  })
}
