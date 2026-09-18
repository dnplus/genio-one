import { createHash, randomBytes } from "node:crypto"
import { persistOtel } from "./otlp-observability"

export const GATEWAY_DETAIL_RETENTION_SECONDS = 86_400

export function gatewayDetailActivityReference(
  enabled: boolean,
  correlationId: string,
  occurredAt: number,
) {
  return enabled
    ? {
        detail_availability: "AVAILABLE" as const,
        detail_ref: correlationId,
        detail_expires_at: occurredAt + GATEWAY_DETAIL_RETENTION_SECONDS,
      }
    : {
        detail_availability: "NOT_CAPTURED" as const,
        detail_ref: null,
        detail_expires_at: null,
      }
}

export interface GatewayDetailCaptureInput {
  tenantId: string
  correlationId: string
  requestBody: Uint8Array
  requestBodyTruncated: boolean
  requestContentType: string | null
  responseBody: Uint8Array
  responseBodyTruncated: boolean
  responseContentType: string | null
}

export interface GatewayDetailCapture {
  capture(input: GatewayDetailCaptureInput): Promise<void>
}

export class GatewayDetailBodyBuffer {
  private readonly chunks: Buffer[] = []
  private length = 0
  private overflowed = false

  constructor(private readonly limitBytes = 1_048_576) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 1 || limitBytes > 16_777_216) {
      throw new Error("Gateway detail body limit is invalid")
    }
  }

  append(value: Uint8Array): void {
    const remaining = this.limitBytes - this.length
    if (remaining <= 0) {
      if (value.byteLength > 0) this.overflowed = true
      return
    }
    const accepted = value.byteLength > remaining ? value.subarray(0, remaining) : value
    if (accepted.byteLength > 0) {
      this.chunks.push(Buffer.from(accepted))
      this.length += accepted.byteLength
    }
    if (accepted.byteLength !== value.byteLength) this.overflowed = true
  }

  body(): Buffer {
    return Buffer.concat(this.chunks, this.length)
  }

  truncated(): boolean {
    return this.overflowed
  }
}

function stringAttribute(key: string, value: string) {
  return { key, value: { stringValue: value } }
}

function booleanAttribute(key: string, value: boolean) {
  return { key, value: { boolValue: value } }
}

const SENSITIVE_KEY = /(^|[_-])(authorization|cookie|credential|password|secret|token|api[_-]?key)([_-]|$)/i
const SENSITIVE_VALUE = /(bearer|basic)\s+\S+|sk-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gi
const REDACTED = "[REDACTED]"
const OMITTED = "[CONTENT_NOT_CAPTURED]"

function sensitiveKey(value: string): boolean {
  if (SENSITIVE_KEY.test(value)) return true
  const normalized = value.replace(/[^a-z0-9]/gi, "").toLowerCase()
  return [
    "authorization",
    "cookie",
    "credential",
    "password",
    "secret",
    "token",
    "apikey",
    "clientsecret",
    "accesstoken",
    "refreshtoken",
    "idtoken",
    "privatekey",
    "privatekeypem",
    "encryptionkey",
    "signingkey",
    "devicecode",
    "usercode",
    "authorizationcode",
    "codeverifier",
    "pkceverifier",
  ].some((suffix) => normalized === suffix || normalized.endsWith(suffix))
}

function sanitizeValue(value: unknown, key?: string): { value: unknown; redacted: boolean } {
  if (key && sensitiveKey(key)) return { value: REDACTED, redacted: true }
  if (typeof value === "string") {
    try {
      const nested = /^\s*[\[{]/.test(value) ? JSON.parse(value) : null
      if (nested && typeof nested === "object") {
        const sanitized = sanitizeValue(nested)
        if (sanitized.redacted) return { value: JSON.stringify(sanitized.value), redacted: true }
      }
    } catch {}
    const sanitized = value.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED).replace(SENSITIVE_VALUE, REDACTED).replace(/([?&#](?:access_token|refresh_token|id_token|token|api_key|secret|password|code|device_code|user_code|code_verifier)=)[^&#\s]*/gi, `$1${REDACTED}`)
    return { value: sanitized, redacted: sanitized !== value }
  }
  if (Array.isArray(value)) {
    let redacted = false
    const result = value.map((entry) => {
      const sanitized = sanitizeValue(entry)
      redacted ||= sanitized.redacted
      return sanitized.value
    })
    return { value: result, redacted }
  }
  if (value && typeof value === "object") {
    let redacted = false
    const result = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([entryKey, entry]) => {
      const sanitized = sanitizeValue(entry, entryKey)
      redacted ||= sanitized.redacted
      return [entryKey, sanitized.value]
    }))
    return { value: result, redacted }
  }
  return { value, redacted: false }
}

export function sanitizeGatewayDetailBody(
  body: Uint8Array,
  contentType: string | null,
): { value: string; redacted: boolean; disposition: "SANITIZED" | "OMITTED"; digest: string } {
  const digest = createHash("sha256").update(body).digest("hex")
  const mimeType = contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? ""
  const raw = Buffer.from(body).toString("utf8")
  if (mimeType === "application/json" || mimeType.endsWith("+json")) {
    try {
      const sanitized = sanitizeValue(JSON.parse(raw) as unknown)
      return {
        value: JSON.stringify(sanitized.value),
        redacted: sanitized.redacted,
        disposition: "SANITIZED",
        digest,
      }
    } catch {
      return { value: OMITTED, redacted: true, disposition: "OMITTED", digest }
    }
  }
  if (mimeType === "application/x-www-form-urlencoded") {
    const values = new URLSearchParams(raw)
    let redacted = false
    for (const key of [...values.keys()]) {
      const sanitized = sanitizeValue(values.get(key) ?? "", key)
      redacted ||= sanitized.redacted
      values.set(key, String(sanitized.value))
    }
    return { value: values.toString(), redacted, disposition: "SANITIZED", digest }
  }
  return { value: OMITTED, redacted: true, disposition: "OMITTED", digest }
}

export function createOtlpGatewayDetailCapture(options: {
  endpoint: string
  serviceName?: string
  persist?: typeof persistOtel
}): GatewayDetailCapture {
  const persist = options.persist ?? persistOtel
  const endpoint = options.endpoint.trim()
  if (!endpoint) throw new Error("OTLP trace endpoint is required")
  const serviceName = options.serviceName ?? "genio-one-gateway-detail-capture"

  return {
    async capture(input) {
      const started = BigInt(Date.now()) * 1_000_000n
      const requestDetail = sanitizeGatewayDetailBody(input.requestBody, input.requestContentType)
      const responseDetail = sanitizeGatewayDetailBody(input.responseBody, input.responseContentType)
      const accepted = await persist("traces", {
          resourceSpans: [{
            resource: {
              attributes: [
                stringAttribute("service.name", serviceName),
                stringAttribute("genio.tenant.id", input.tenantId),
              ],
            },
            scopeSpans: [{
              scope: { name: serviceName },
              spans: [{
                traceId: randomBytes(16).toString("hex"),
                spanId: randomBytes(8).toString("hex"),
                name: "gateway.message.detail",
                kind: 1,
                startTimeUnixNano: String(started),
                endTimeUnixNano: String(started + 1_000_000n),
                attributes: [
                  stringAttribute("genio.tenant.id", input.tenantId),
                  stringAttribute("genio.correlation.id", input.correlationId),
                  stringAttribute("input.value", requestDetail.value),
                  stringAttribute("input.sha256", requestDetail.digest),
                  stringAttribute("input.capture_disposition", requestDetail.disposition),
                  booleanAttribute("input.redacted", requestDetail.redacted),
                  booleanAttribute("input.truncated", input.requestBodyTruncated),
                  stringAttribute("input.mime_type", input.requestContentType ?? "application/octet-stream"),
                  stringAttribute("output.value", responseDetail.value),
                  stringAttribute("output.sha256", responseDetail.digest),
                  stringAttribute("output.capture_disposition", responseDetail.disposition),
                  booleanAttribute("output.redacted", responseDetail.redacted),
                  booleanAttribute("output.truncated", input.responseBodyTruncated),
                  stringAttribute("output.mime_type", input.responseContentType ?? "application/octet-stream"),
                ],
                status: { code: 1 },
              }],
            }],
          }],
      }, endpoint.replace(/\/v1\/traces$/, ""))
      if (!accepted) throw new Error("OTLP_GATEWAY_DETAIL_PERSIST_FAILED")
    },
  }
}
