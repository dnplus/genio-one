import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto"

import { compareUtf8 } from "@genioone/protocol/canonical"

export const RUNTIME_REPORT_KEY_ID_HEADER = "x-genio-runtime-report-key-id" as const
export const RUNTIME_REPORT_SIGNATURE_HEADER = "x-genio-runtime-report-signature" as const

type KeyOrder = (left: string, right: string) => number

function canonicalValue(value: unknown, order: KeyOrder): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalValue(item, order)).join(",")}]`
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => order(left, right))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalValue(item, order)}`).join(",")}}`
  }
  throw new Error("RUNTIME_REPORT_CANONICAL_VALUE_INVALID")
}

export function canonicalRuntimeReportPayload(value: Record<string, unknown>): string {
  return canonicalValue(value, compareUtf8)
}

function legacyRuntimeReportPayload(value: Record<string, unknown>): string {
  return canonicalValue(value, (left, right) => left.localeCompare(right))
}

export function signRuntimeReport(value: Record<string, unknown>, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem)
  if (key.asymmetricKeyType !== "ed25519") throw new Error("RUNTIME_REPORT_PRIVATE_KEY_INVALID")
  return sign(null, Buffer.from(canonicalRuntimeReportPayload(value)), key).toString("base64url")
}

export function verifyRuntimeReport(
  value: Record<string, unknown>,
  signature: string,
  publicKeyPem: string,
): boolean {
  if (!/^[A-Za-z0-9_-]{86}$/.test(signature)) return false
  try {
    const key = createPublicKey(publicKeyPem)
    if (key.asymmetricKeyType !== "ed25519") return false
    const bytes = Buffer.from(signature, "base64url")
    return (
      verify(null, Buffer.from(canonicalRuntimeReportPayload(value)), key, bytes) ||
      verify(null, Buffer.from(legacyRuntimeReportPayload(value)), key, bytes)
    )
  } catch {
    return false
  }
}
