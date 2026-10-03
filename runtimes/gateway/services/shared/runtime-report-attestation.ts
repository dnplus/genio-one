import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto"

import { compareUtf8 } from "@genioone/protocol/canonical"

export const RUNTIME_REPORT_KEY_ID_HEADER = "x-genio-runtime-report-key-id" as const
export const RUNTIME_REPORT_SIGNATURE_HEADER = "x-genio-runtime-report-signature" as const
export const RUNTIME_POLICY_RESPONSE_KEY_ID_HEADER = "x-genio-runtime-policy-response-key-id" as const
export const RUNTIME_POLICY_RESPONSE_SIGNATURE_HEADER = "x-genio-runtime-policy-response-signature" as const
export const RUNTIME_POLICY_REQUEST_NONCE_HEADER = "x-genio-runtime-policy-request-nonce" as const

export type RuntimePolicyResponseInput = {
  kind: "AUTHORIZE_RESPONSE"
  tenantId: string
  nonce: string
  request: object
  response: object
} | {
  kind: "REPORT_ACK"
  tenantId: string
  request: object
  response: object
}

export interface RuntimePolicyResponseSigner {
  keyId: string
  sign(input: RuntimePolicyResponseInput): string
}

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

export function isRuntimePolicyResponseNonce(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
}

function runtimePolicyResponsePayload(input: RuntimePolicyResponseInput): Record<string, unknown> {
  return {
    domain: "genioone.runtime-policy.response.v1",
    kind: input.kind,
    tenant_id: input.tenantId,
    ...(input.kind === "AUTHORIZE_RESPONSE" ? { nonce: input.nonce } : {}),
    request: input.request,
    response: input.response,
  }
}

export function createRuntimePolicyResponseSigner(keyId: string, privateKeyPem: string): RuntimePolicyResponseSigner {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(keyId)) throw new Error("RUNTIME_POLICY_RESPONSE_KEY_ID_INVALID")
  const key = createPrivateKey(privateKeyPem)
  if (key.asymmetricKeyType !== "ed25519") throw new Error("RUNTIME_POLICY_RESPONSE_PRIVATE_KEY_INVALID")
  return {
    keyId,
    sign(input) {
      return sign(null, Buffer.from(canonicalRuntimeReportPayload(runtimePolicyResponsePayload(input))), key).toString("base64url")
    },
  }
}

export function verifyRuntimePolicyResponse(input: RuntimePolicyResponseInput, signature: string, publicKeyPem: string): boolean {
  if (!/^[A-Za-z0-9_-]{86}$/.test(signature)) return false
  try {
    const key = createPublicKey(publicKeyPem)
    return key.asymmetricKeyType === "ed25519" && verify(null, Buffer.from(canonicalRuntimeReportPayload(runtimePolicyResponsePayload(input))), key, Buffer.from(signature, "base64url"))
  } catch {
    return false
  }
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
