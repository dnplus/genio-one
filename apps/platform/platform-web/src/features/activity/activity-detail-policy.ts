import type { ApiGatewayActivityEvent } from "@/domain/contracts"

type GatewayActivityDetailState = Pick<
  ApiGatewayActivityEvent,
  "detail_availability" | "detail_expires_at" | "enforcement_point_id"
>

export function gatewayActivityDetailAvailability(
  event: GatewayActivityDetailState,
  now = Math.floor(Date.now() / 1_000),
): ApiGatewayActivityEvent["detail_availability"] {
  if (
    event.detail_availability === "AVAILABLE" &&
    event.detail_expires_at !== null &&
    event.detail_expires_at <= now
  ) return "EXPIRED"
  return event.detail_availability
}

export function shouldLoadGatewayActivityDetail(
  event: GatewayActivityDetailState,
): boolean {
  const availability = gatewayActivityDetailAvailability(event)
  return availability !== "EXPIRED" && (
    availability === "AVAILABLE" ||
    event.enforcement_point_id === "AI_GATEWAY"
  )
}
