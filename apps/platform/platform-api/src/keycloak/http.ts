export type KeycloakJsonRecord = Record<string, unknown>

export function keycloakRequired(value: string, name: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${name} is required`)
  return normalized
}

export async function keycloakResponseJson(response: Response, label: string): Promise<unknown> {
  const text = await response.text()
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}: ${text.slice(0, 256)}`)
  return text.trim() ? JSON.parse(text) as unknown : null
}

export function keycloakRecords(value: unknown, label: string): KeycloakJsonRecord[] {
  if (!Array.isArray(value) || !value.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry))) {
    throw new Error(`${label} response is invalid`)
  }
  return value as KeycloakJsonRecord[]
}

export function keycloakString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is missing`)
  return value
}
