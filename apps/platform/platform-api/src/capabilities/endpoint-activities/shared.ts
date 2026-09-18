import { PlatformApiError } from "../errors"

export function canonicalDestination(value: string): string {
  const input = value.trim().toLowerCase()
  if (!input || input.length > 253 || /[\u0000\r\n/:]/.test(input)) {
    throw new PlatformApiError("ENDPOINT_DESTINATION_INVALID", 422)
  }
  const labels = input.endsWith(".") ? input.slice(0, -1).split(".") : input.split(".")
  if (
    labels.length === 0 ||
    labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
  ) {
    throw new PlatformApiError("ENDPOINT_DESTINATION_INVALID", 422)
  }
  return labels.join(".")
}

export function endpointClient(event: {
  acting_client: { acting_client_id: string | null; evidence_level: string }
}) {
  return event.acting_client.evidence_level === "VERIFIED" && event.acting_client.acting_client_id
    ? { status: "VERIFIED" as const, acting_client_id: event.acting_client.acting_client_id }
    : { status: "UNKNOWN" as const }
}
