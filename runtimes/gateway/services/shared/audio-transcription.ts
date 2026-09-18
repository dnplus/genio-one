export const MAX_TRANSCRIPTION_BYTES = 4_000_000

export function isAudioMultipart(contentType: string): boolean {
  return /^multipart\/form-data(?:;|$)/i.test(contentType)
}

export async function transcriptionFields(body: Uint8Array, contentType: string): Promise<Record<string, string>> {
  if (!body.byteLength || body.byteLength > MAX_TRANSCRIPTION_BYTES) throw new Error("ASR_AUDIO_TOO_LARGE")
  const form = await new Response(Buffer.from(body), { headers: { "content-type": contentType } }).formData()
  const fields: Record<string, string> = {}
  const allowed = new Set(["model", "language", "prompt", "response_format", "temperature"])
  let files = 0
  for (const [key, value] of form) {
    if (key === "file" && typeof value !== "string") {
      if (++files > 1 || value.size === 0) throw new Error("ASR_INVALID_FILE")
    } else if (allowed.has(key) && typeof value === "string" && !Object.hasOwn(fields, key)) {
      fields[key] = value
    } else {
      throw new Error("ASR_INVALID_FIELD")
    }
  }
  if (files !== 1 || !fields.model?.trim() || fields.model.length > 256 || /[\u0000\r\n]/.test(fields.model)) throw new Error("ASR_INVALID_MODEL")
  if (fields.response_format && fields.response_format !== "json") throw new Error("ASR_JSON_REQUIRED")
  return fields
}

export async function prepareTranscriptionRequest(body: Uint8Array, contentType: string, hasRequestSteps: boolean) {
  if (!isAudioMultipart(contentType)) return { body, restore: (result: Uint8Array) => result }
  if (hasRequestSteps) throw new Error("ASR_REQUEST_PROCESSORS_UNSUPPORTED")
  const fields = await transcriptionFields(body, contentType)
  return {
    body: Buffer.from(JSON.stringify(fields)),
    restore(result: Uint8Array): Uint8Array {
      const processed = JSON.parse(Buffer.from(result).toString("utf8")) as Record<string, unknown>
      if (Object.keys(processed).length !== Object.keys(fields).length || Object.entries(fields).some(([key, value]) => processed[key] !== value)) {
        throw new Error("ASR_REQUEST_REWRITE_UNSUPPORTED")
      }
      return body
    },
  }
}
