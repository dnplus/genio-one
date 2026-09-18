import { recordOperationalLog } from "./otlp-observability"
const sensitiveQueryValue = /([?&](?:access_token|api_key|key|password|secret|token)=)[^&\s]+/gi
const bearerValue = /\bBearer\s+[^\s]+/gi
const basicUrlIdentity = /(https?:\/\/)[^/@\s]+@/gi
const controlCharacters = /[\u0000-\u001f\u007f]+/g

function safeText(value: string): string {
  return value
    .replace(basicUrlIdentity, "$1[REDACTED]@")
    .replace(sensitiveQueryValue, "$1[REDACTED]")
    .replace(bearerValue, "Bearer [REDACTED]")
    .replace(controlCharacters, " ")
    .trim()
    .slice(0, 2_048)
}

export function operationalError(error: unknown) {
  if (error instanceof Error) {
    return {
      error_name: safeText(error.name || "Error"),
      error_message: safeText(error.message || "Operation failed"),
    }
  }
  return {
    error_name: "Error",
    error_message: safeText(String(error || "Operation failed")),
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
  })}\n`
  if (level === "ERROR") process.stderr.write(line)
  else process.stdout.write(line)
}
