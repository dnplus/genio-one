import { recordOperationalLog } from "./otlp-observability"
const sensitiveQueryValue = /([?&](?:access_token|api_key|key|password|secret|token)=)[^&\s]+/gi
const bearerValue = /\bBearer\s+[^\s]+/gi
const basicUrlIdentity = /(https?:\/\/)[^/@\s]+@/gi
const controlCharacters = /[\u0000-\u001f\u007f]+/g
const sensitiveField = /^(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|password|passwd|secret|client[-_]?secret|token|access[-_]?token|refresh[-_]?token|api[-_]?key)$/i

// Redact before either sink, including the durable producer outbox.
function safeText(value: string): string {
  return value
    .replace(basicUrlIdentity, "$1[REDACTED]@")
    .replace(sensitiveQueryValue, "$1[REDACTED]")
    .replace(bearerValue, "Bearer [REDACTED]")
    .replace(controlCharacters, " ")
    .trim()
}

export function operationalError(error: unknown) {
  if (error instanceof Error) {
    return {
      error_name: error.name || "Error",
      error_message: error.message || "Operation failed",
    }
  }
  return {
    error_name: "Error",
    error_message: String(error || "Operation failed"),
  }
}

export function writeOperationalEvent(
  component: "authorizer" | "gateway-runtime" | "processor",
  level: "INFO" | "WARN" | "ERROR",
  event: string,
  fields: Readonly<Record<string, unknown>> = {},
): void {
  const payload = JSON.parse(JSON.stringify({
    ...fields,
    component,
    event,
    level,
  }, (key, value) => sensitiveField.test(key) && value != null
    ? "[REDACTED]"
    : typeof value === "string" ? safeText(value) : value))
  const { component: safeComponent, event: safeEvent, level: safeLevel, ...safeFields } = payload
  recordOperationalLog(safeComponent, safeLevel, safeEvent, safeFields)
  const line = `${JSON.stringify(payload)}\n`
  if (level === "ERROR") process.stderr.write(line)
  else process.stdout.write(line)
}
