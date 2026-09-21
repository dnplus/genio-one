export function compareUtf8(left: string, right: string): number {
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

function serializeCanonicalValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return `[${Array.from({ length: value.length }, (_, index) => serializeCanonicalValue(value[index]) ?? "null").join(",")}]`
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    const entries = Object.keys(record)
      .sort(compareUtf8)
      .flatMap((key) => {
        const serialized = serializeCanonicalValue(record[key])
        return serialized === undefined ? [] : [`${JSON.stringify(key)}:${serialized}`]
      })
    return `{${entries.join(",")}}`
  }
  return JSON.stringify(value)
}

export function canonicalJson(value: unknown): string {
  return serializeCanonicalValue(canonicalValue(value))!
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value))
}
