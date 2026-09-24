import { recordOperationalLog } from "./otlp-observability"
const sensitiveQueryValue = /([?&](?:access_token|api_key|key|password|secret|token)=)[^&\s]+/gi
const bearerValue = /\bBearer\s+[^\s]+/gi
const basicUrlIdentity = /(https?:\/\/)[^/@\s]+@/gi
const controlCharacters = /[\u0000-\u001f\u007f]+/g

// Applied to the stdout/stderr line only: that sink bypasses the analytics collector's redaction.
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
  recordOperationalLog(component, level, event, fields)
  const line = `${JSON.stringify({
    ...fields,
    component,
    event,
    level,
  }, (_key, value) => typeof value === "string" ? safeText(value) : value)}\n`
  if (level === "ERROR") process.stderr.write(line)
  else process.stdout.write(line)
}
