export const DEFAULT_SAFETY_BUFFER_BYTES = 4 * 1024 * 1024
export const MAX_SAFETY_BUFFER_BYTES = 16 * 1024 * 1024

export function safetyBufferBytesFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const source = environment.GENIO_ONE_AI_PROCESSOR_SAFETY_MAX_BUFFER_BYTES?.trim()
  if (!source) return DEFAULT_SAFETY_BUFFER_BYTES
  if (!/^[1-9][0-9]*$/.test(source)) {
    throw new Error("GENIO_ONE_AI_PROCESSOR_SAFETY_MAX_BUFFER_BYTES is invalid")
  }
  const value = Number(source)
  if (!Number.isSafeInteger(value) || value > MAX_SAFETY_BUFFER_BYTES) {
    throw new Error("GENIO_ONE_AI_PROCESSOR_SAFETY_MAX_BUFFER_BYTES is invalid")
  }
  return value
}

export function safetyBufferByteLimit(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || !value || value < 0) return DEFAULT_SAFETY_BUFFER_BYTES
  return Math.min(value, MAX_SAFETY_BUFFER_BYTES)
}

export function appendSafetyBuffer(
  chunks: Buffer[],
  size: number,
  value: Uint8Array,
  maxBytes: number,
): number {
  const nextSize = size + value.byteLength
  if (!Number.isSafeInteger(nextSize) || nextSize > maxBytes) {
    throw new Error("SAFETY_BUFFER_LIMIT_EXCEEDED")
  }
  chunks.push(Buffer.from(value))
  return nextSize
}
