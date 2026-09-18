import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

export interface McpOAuthSecretCodec {
  seal(value: unknown): string
  open<T>(value: string): T
}

const MAX_SEALED_PAYLOAD_BYTES = 1_048_576
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

function invalidSealedValue(): Error {
  return new Error("MCP OAuth sealed value is invalid")
}

function decodePart(value: string | undefined, exactBytes?: number): Buffer {
  if (
    !value ||
    !BASE64URL_PATTERN.test(value) ||
    value.length > Math.ceil(MAX_SEALED_PAYLOAD_BYTES * 4 / 3) + 16
  ) throw invalidSealedValue()
  const decoded = Buffer.from(value, "base64url")
  if (
    decoded.toString("base64url") !== value ||
    (exactBytes !== undefined && decoded.byteLength !== exactBytes) ||
    decoded.byteLength > MAX_SEALED_PAYLOAD_BYTES
  ) throw invalidSealedValue()
  return decoded
}

export function createMcpOAuthSecretCodec(key: Uint8Array): McpOAuthSecretCodec {
  if (key.byteLength !== 32) throw new Error("MCP OAuth encryption key must be 32 bytes")
  return {
    seal(value) {
      const plaintext = JSON.stringify(value)
      if (
        plaintext === undefined ||
        Buffer.byteLength(plaintext, "utf8") > MAX_SEALED_PAYLOAD_BYTES
      ) throw invalidSealedValue()
      const iv = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", key, iv)
      const encrypted = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ])
      return [
        "v1",
        iv.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        encrypted.toString("base64url"),
      ].join(".")
    },
    open<T>(value: string): T {
      if (value.length > 1_398_320) throw invalidSealedValue()
      const parts = value.split(".")
      if (parts.length !== 4 || parts[0] !== "v1") {
        throw invalidSealedValue()
      }
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, decodePart(parts[1], 12))
        decipher.setAuthTag(decodePart(parts[2], 16))
        const plaintext = Buffer.concat([
          decipher.update(decodePart(parts[3])),
          decipher.final(),
        ]).toString("utf8")
        return JSON.parse(plaintext) as T
      } catch {
        throw invalidSealedValue()
      }
    },
  }
}
