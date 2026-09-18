import { createHash, randomBytes, randomUUID } from "node:crypto"
import { PlatformApiError } from "../errors"
import type { EndpointCredentialIdentity } from "./module"

export interface EndpointCredentialRecord extends EndpointCredentialIdentity {
  tokenHash: string
  consumedAt: number | null
  revokedAt: number | null
}

export function credentialHash(token: string) {
  return createHash("sha256").update(token).digest("hex")
}

export function issueCredential(input: {
  tenantId: string
  deviceId: string
  subjectId: string
  kind: "BOOTSTRAP" | "RUNTIME"
}, now: number) {
  const token = `genio_endpoint_${input.kind.toLowerCase()}_${randomBytes(32).toString("base64url")}`
  const record: EndpointCredentialRecord = { ...input, credentialId: randomUUID(), tokenHash: credentialHash(token),
    expiresAt: now + (input.kind === "BOOTSTRAP" ? 300 : 86400), consumedAt: null, revokedAt: null }
  return { record, credential: { token, expires_at: record.expiresAt } }
}

export function assertCredential(record: EndpointCredentialRecord | undefined, tenantId: string, now: number) {
  if (!record || record.tenantId !== tenantId || record.expiresAt <= now || record.consumedAt !== null || record.revokedAt !== null) {
    throw new PlatformApiError("ENDPOINT_CREDENTIAL_REJECTED", 401)
  }
  return record
}
