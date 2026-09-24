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

export type DetailBodyCapture = { value: string; encoding: "utf8" | "utf8-lossy"; digest: string }

// Raw capture only. Credential redaction runs once, server side, in the analytics collector
// (transform/redact_credentials), which can only read text: bodies are therefore always exported
// as UTF-8 text, never an encoding the collector cannot see through. Invalid UTF-8 is decoded
// lossily (U+FFFD) and flagged utf8-lossy; the exact original bytes are identified by sha256.
// Pass final=false for successive parts of one stream so a character split across parts survives.
export function createDetailBodyDecoder(): (body: Uint8Array, final?: boolean) => DetailBodyCapture {
  const strict = new TextDecoder("utf-8", { fatal: true })
  const lossy = new TextDecoder("utf-8")
  let encoding: DetailBodyCapture["encoding"] = "utf8"
  // The lossy decoder always produces the text, so bytes it buffered from an earlier part are
  // replayed correctly when the sequence turns out invalid; the strict decoder only detects that.
  return (body, final = true) => {
    const digest = createHash("sha256").update(body).digest("hex")
    const value = lossy.decode(body, { stream: !final })
    if (encoding === "utf8") {
      try {
        strict.decode(body, { stream: !final })
      } catch {
        encoding = "utf8-lossy"
      }
    }
    return { value, encoding, digest }
  }
}

export function captureDetailBody(body: Uint8Array): DetailBodyCapture {
  return createDetailBodyDecoder()(body)
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
      const requestDetail = captureDetailBody(input.requestBody)
      const responseDetail = captureDetailBody(input.responseBody)
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
                  stringAttribute("input.encoding", requestDetail.encoding),
                  booleanAttribute("input.truncated", input.requestBodyTruncated),
                  stringAttribute("input.mime_type", input.requestContentType ?? "application/octet-stream"),
                  stringAttribute("output.value", responseDetail.value),
                  stringAttribute("output.sha256", responseDetail.digest),
                  stringAttribute("output.encoding", responseDetail.encoding),
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
