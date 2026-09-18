import { createPublicKey, verify } from "node:crypto"

export interface VerificationKeyRing {
  schema_version: 1
  keys: Array<{ key_id: string; public_key_pem: string }>
}

interface CompactJwsHeader {
  alg: "EdDSA"
  kid: string
  typ?: string
}

function decodeJson(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value === value.trim()
}

function presentString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

export function verifyCompactEdDsaJws(
  compactJws: string,
  keyRing: VerificationKeyRing,
): unknown {
  if (
    keyRing.schema_version !== 1 ||
    !Array.isArray(keyRing.keys) ||
    keyRing.keys.length === 0 ||
    !keyRing.keys.every(
      (key) => nonEmptyString(key.key_id) && presentString(key.public_key_pem),
    )
  ) {
    throw new Error("verification keyring is invalid")
  }

  const parts = compactJws.trim().split(".")
  if (parts.length !== 3) throw new Error("payload is not compact JWS")

  const [encodedHeader, encodedPayload, encodedSignature] = parts
  const header = decodeJson(encodedHeader) as CompactJwsHeader
  if (header.alg !== "EdDSA" || !nonEmptyString(header.kid)) {
    throw new Error("compact JWS header is invalid")
  }
  const key = keyRing.keys.find((candidate) => candidate.key_id === header.kid)
  if (!key) throw new Error("signing key is unknown")

  const verified = verify(
    null,
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    createPublicKey(key.public_key_pem),
    Buffer.from(encodedSignature, "base64url"),
  )
  if (!verified) throw new Error("compact JWS signature is invalid")
  return decodeJson(encodedPayload)
}
