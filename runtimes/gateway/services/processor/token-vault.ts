import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto"

import { createClient, type RedisClientType } from "redis"

import type { ProcessingContext } from "./contract"

export interface TokenVault {
  store(
    context: ProcessingContext,
    token: string,
    value: string,
    ttlSeconds: number,
  ): Promise<void>
  resolve(context: ProcessingContext, token: string): Promise<string | null>
}

interface CiphertextEnvelope {
  iv: string
  tag: string
  ciphertext: string
}

const MAX_CIPHERTEXT_BYTES = 1_048_576
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/
const TOKEN_PATTERN = /^(?:<[A-Z][A-Z0-9_]{0,31}:[A-Za-z0-9_-]{6,8}>|__GENIO_[A-Za-z0-9_-]+__)$/

function invalidEnvelope(): Error {
  return new Error("token vault entry is invalid")
}

function decodeBase64Url(value: unknown, exactBytes?: number): Buffer {
  if (
    typeof value !== "string" ||
    !BASE64URL_PATTERN.test(value) ||
    value.length > Math.ceil(MAX_CIPHERTEXT_BYTES * 4 / 3) + 16
  ) throw invalidEnvelope()
  const decoded = Buffer.from(value, "base64url")
  if (
    decoded.toString("base64url") !== value ||
    (exactBytes !== undefined && decoded.byteLength !== exactBytes) ||
    decoded.byteLength > MAX_CIPHERTEXT_BYTES
  ) throw invalidEnvelope()
  return decoded
}

function parseEnvelope(encoded: string): {
  iv: Buffer
  tag: Buffer
  ciphertext: Buffer
} {
  if (encoded.length > 1_398_256) throw invalidEnvelope()
  let value: unknown
  try {
    value = JSON.parse(encoded) as unknown
  } catch {
    throw invalidEnvelope()
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidEnvelope()
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (
    keys.length !== 3 ||
    !Object.hasOwn(record, "iv") ||
    !Object.hasOwn(record, "tag") ||
    !Object.hasOwn(record, "ciphertext")
  ) throw invalidEnvelope()
  return {
    iv: decodeBase64Url(record.iv, 12),
    tag: decodeBase64Url(record.tag, 16),
    ciphertext: decodeBase64Url(record.ciphertext),
  }
}

function validateStoreInput(token: string, value: string, ttlSeconds: number): void {
  if (!TOKEN_PATTERN.test(token) || token.length > 128) {
    throw new Error("token vault token is invalid")
  }
  if (Buffer.byteLength(value, "utf8") > MAX_CIPHERTEXT_BYTES) {
    throw new Error("token vault value is too large")
  }
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 86_400) {
    throw new Error("token vault TTL is invalid")
  }
}

/**
 * Token values are request data, not credentials.  They still need a strict
 * cryptographic binding because a caller can replay a session id with a
 * different verified identity.  Keep the same tuple in the Valkey namespace
 * and in AES-GCM AAD so neither a key collision nor a copied token can cross
 * tenant, subject, client, resource, capability, or session boundaries.
 */
function contextValues(context: ProcessingContext): string[] {
  const values = [
    context.tenantId,
    context.subjectId,
    context.clientId,
    context.resourceId,
    context.capabilityId,
    context.sessionId,
  ]
  if (values.some((value) => !value || /[\u0000\r\n]/.test(value))) {
    throw new Error("token vault context contains an invalid value")
  }
  return values
}

function namespaceBinding(context: ProcessingContext): string {
  return JSON.stringify({ version: 1, values: contextValues(context) })
}

function aadBinding(context: ProcessingContext, token: string): string {
  const values = [...contextValues(context), context.correlationId, token]
  if (values.some((value) => !value || /[\u0000\r\n]/.test(value))) {
    throw new Error("token vault context contains an invalid value")
  }
  return JSON.stringify({ version: 1, values })
}

export class EncryptedValkeyTokenVault implements TokenVault {
  private readonly client: RedisClientType

  constructor(
    origin: string,
    private readonly encryptionKey: Buffer,
    client?: RedisClientType,
  ) {
    if (encryptionKey.byteLength !== 32) {
      throw new Error("token vault encryption key must contain exactly 32 bytes")
    }
    this.client = client ?? createClient({ url: origin })
  }

  async connect(): Promise<void> {
    if (!this.client.isOpen) await this.client.connect()
  }

  async close(): Promise<void> {
    if (this.client.isOpen) await this.client.quit()
  }

  async store(
    context: ProcessingContext,
    token: string,
    value: string,
    ttlSeconds: number,
  ): Promise<void> {
    validateStoreInput(token, value, ttlSeconds)
    await this.connect()
    const iv = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv)
    cipher.setAAD(Buffer.from(this.aad(context, token)))
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
    const envelope: CiphertextEnvelope = {
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    }
    await this.client.set(this.key(context, token), JSON.stringify(envelope), {
      EX: ttlSeconds,
    })
  }

  async resolve(context: ProcessingContext, token: string): Promise<string | null> {
    if (!TOKEN_PATTERN.test(token) || token.length > 128) {
      throw new Error("token vault token is invalid")
    }
    await this.connect()
    const encoded = await this.client.get(this.key(context, token))
    if (!encoded) return null
    const envelope = parseEnvelope(encoded)
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.encryptionKey,
      envelope.iv,
    )
    decipher.setAAD(Buffer.from(this.aad(context, token)))
    decipher.setAuthTag(envelope.tag)
    return Buffer.concat([
      decipher.update(envelope.ciphertext),
      decipher.final(),
    ]).toString("utf8")
  }

  private key(context: ProcessingContext, token: string): string {
    const namespace = createHash("sha256")
      .update(namespaceBinding(context))
      .digest("hex")
    return `genio-one:token-vault:v1:${namespace}:${token}`
  }

  private aad(context: ProcessingContext, token: string): string {
    return aadBinding(context, token)
  }
}
