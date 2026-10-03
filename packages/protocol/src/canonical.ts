const HAS_NON_ASCII = /[^\x00-\x7F]/
const HAS_SURROGATE = /[\uD800-\uDFFF]/

export function compareUtf8(left: string, right: string): number {
  if (left === right) return 0
  if (!HAS_NON_ASCII.test(left) && !HAS_NON_ASCII.test(right)) {
    return left < right ? -1 : 1
  }
  if (!HAS_SURROGATE.test(left) && !HAS_SURROGATE.test(right)) {
    return left < right ? -1 : 1
  }
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
}

export function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort(compareUtf8)
        .map((key) => [key, canonicalValue(record[key])]),
    )
  }
  return value
}

// Serialize without first cloning the whole value graph. Keep canonicalValue's
// undefined filter before the sorted second read so accessor values agree too.
function serializeCanonicalValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const len = value.length
    const items = new Array(len)
    for (let i = 0; i < len; i++) {
      items[i] = serializeCanonicalValue(value[i]) ?? "null"
    }
    return `[${items.join(",")}]`
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort(compareUtf8)
    const entries: string[] = []
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!
      const serialized = serializeCanonicalValue(record[key])
      if (serialized !== undefined) {
        entries.push(`${JSON.stringify(key)}:${serialized}`)
      }
    }
    return `{${entries.join(",")}}`
  }
  return JSON.stringify(value)
}

export function canonicalJson(value: unknown): string {
  return serializeCanonicalValue(value)!
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value))
}
