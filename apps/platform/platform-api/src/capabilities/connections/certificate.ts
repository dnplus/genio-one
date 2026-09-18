import { X509Certificate } from "node:crypto"

import { PlatformApiError } from "../errors"
import type {
  ConnectionCertificate,
  ConnectionCertificateMode,
  ConnectionCertificateStatus,
} from "./contract"

const CERTIFICATE_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g
const MAX_CERTIFICATE_BYTES = 131_072
const EXPIRING_WINDOW_SECONDS = 30 * 24 * 60 * 60

export interface ConnectionCertificateInput {
  mode: ConnectionCertificateMode
  certificate_pem?: string | null
}

export interface StoredConnectionCertificate {
  mode: unknown
  certificate_pem: unknown
  fingerprint_sha256: unknown
  subject: unknown
  issuer: unknown
  is_self_signed: unknown
  not_before: unknown
  not_after: unknown
}

function certificateError(message = "A valid PEM X.509 certificate is required"): PlatformApiError {
  return new PlatformApiError("CONNECTION_CERTIFICATE_INVALID", 422, message)
}

function timestamp(value: string, field: string): number {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw certificateError(`Certificate ${field} is invalid`)
  return Math.floor(parsed / 1000)
}

function normalizedBlocks(value: string): string[] {
  if (new TextEncoder().encode(value).byteLength > MAX_CERTIFICATE_BYTES) {
    throw certificateError("Certificate PEM exceeds the 128 KiB limit")
  }
  const blocks = value.match(CERTIFICATE_BLOCK) ?? []
  if (blocks.length === 0 || blocks.length > 16) throw certificateError()
  if (value.replace(CERTIFICATE_BLOCK, "").trim()) {
    throw certificateError("Certificate PEM contains unsupported data")
  }
  return blocks.map((block) => block.trim())
}

function statusFor(
  certificate: Pick<ConnectionCertificate, "mode" | "not_before" | "not_after">,
  evaluatedAt: number,
): ConnectionCertificateStatus {
  if (certificate.mode === "SYSTEM_CA") return "NOT_CONFIGURED"
  if (certificate.not_before === null || certificate.not_after === null) return "INVALID"
  if (evaluatedAt < certificate.not_before) return "NOT_YET_VALID"
  if (evaluatedAt >= certificate.not_after) return "EXPIRED"
  if (certificate.not_after - evaluatedAt <= EXPIRING_WINDOW_SECONDS) return "EXPIRING"
  return "VALID"
}

export function parseConnectionCertificate(
  input: ConnectionCertificateInput,
  evaluatedAt = Math.floor(Date.now() / 1000),
): ConnectionCertificate {
  if (input.mode === "SYSTEM_CA") {
    if (input.certificate_pem?.trim()) {
      throw certificateError("System CA mode cannot include a custom certificate")
    }
    return {
      mode: "SYSTEM_CA",
      certificate_pem: null,
      fingerprint_sha256: null,
      subject: null,
      issuer: null,
      is_self_signed: false,
      not_before: null,
      not_after: null,
      status: "NOT_CONFIGURED",
    }
  }
  const pem = input.certificate_pem?.trim()
  if (!pem) throw certificateError()
  const blocks = normalizedBlocks(pem)
  let first: X509Certificate
  try {
    for (const block of blocks) new X509Certificate(block)
    first = new X509Certificate(blocks[0]!)
  } catch {
    throw certificateError()
  }
  const notBefore = timestamp(first.validFrom, "not_before")
  const notAfter = timestamp(first.validTo, "not_after")
  if (notAfter <= notBefore) throw certificateError("Certificate validity window is invalid")
  const certificate: ConnectionCertificate = {
    mode: "CUSTOM_CA",
    certificate_pem: blocks.join("\n"),
    fingerprint_sha256: first.fingerprint256.replaceAll(":", "").toLowerCase(),
    subject: first.subject,
    issuer: first.issuer,
    is_self_signed: first.subject === first.issuer,
    not_before: notBefore,
    not_after: notAfter,
    status: "VALID",
  }
  return { ...certificate, status: statusFor(certificate, evaluatedAt) }
}

function storedString(value: unknown): string | null {
  return value === null || value === undefined ? null : typeof value === "string" ? value : null
}

function storedTimestamp(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === "bigint") return Number(value)
  if (value instanceof Date) return Math.floor(value.getTime() / 1000)
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

export function connectionCertificateFromStored(
  value: StoredConnectionCertificate,
  evaluatedAt = Math.floor(Date.now() / 1000),
): ConnectionCertificate {
  if (value.mode === "SYSTEM_CA") return parseConnectionCertificate({ mode: "SYSTEM_CA" }, evaluatedAt)
  if (value.mode !== "CUSTOM_CA") {
    throw new PlatformApiError("CONNECTION_CERTIFICATE_DATA_INVALID", 500)
  }
  const pem = storedString(value.certificate_pem)
  const fingerprint = storedString(value.fingerprint_sha256)
  const subject = storedString(value.subject)
  const issuer = storedString(value.issuer)
  const notBefore = storedTimestamp(value.not_before)
  const notAfter = storedTimestamp(value.not_after)
  const isSelfSigned = value.is_self_signed === true
  if (!pem || !fingerprint || !subject || !issuer || notBefore === null || notAfter === null) {
    throw new PlatformApiError("CONNECTION_CERTIFICATE_DATA_INVALID", 500)
  }
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new PlatformApiError("CONNECTION_CERTIFICATE_DATA_INVALID", 500)
  }
  const parsed = parseConnectionCertificate({ mode: "CUSTOM_CA", certificate_pem: pem }, evaluatedAt)
  if (
    parsed.fingerprint_sha256 !== fingerprint ||
    parsed.subject !== subject ||
    parsed.issuer !== issuer ||
    parsed.is_self_signed !== isSelfSigned ||
    parsed.not_before !== notBefore ||
    parsed.not_after !== notAfter
  ) {
    throw new PlatformApiError("CONNECTION_CERTIFICATE_DATA_INVALID", 500)
  }
  return parsed
}

export function certificateStorageValues(certificate: ConnectionCertificate): {
  mode: ConnectionCertificateMode
  pem: string | null
  fingerprint: string | null
  subject: string | null
  issuer: string | null
  isSelfSigned: boolean
  notBefore: number | null
  notAfter: number | null
} {
  return {
    mode: certificate.mode,
    pem: certificate.certificate_pem,
    fingerprint: certificate.fingerprint_sha256,
    subject: certificate.subject,
    issuer: certificate.issuer,
    isSelfSigned: certificate.is_self_signed,
    notBefore: certificate.not_before,
    notAfter: certificate.not_after,
  }
}

export function sameConnectionCertificate(
  left: ConnectionCertificate | undefined,
  right: ConnectionCertificate,
): boolean {
  if (!left) return false
  return left.mode === right.mode &&
    left.certificate_pem === right.certificate_pem &&
    left.fingerprint_sha256 === right.fingerprint_sha256 &&
    left.subject === right.subject &&
    left.issuer === right.issuer &&
    left.is_self_signed === right.is_self_signed &&
    left.not_before === right.not_before &&
    left.not_after === right.not_after
}
