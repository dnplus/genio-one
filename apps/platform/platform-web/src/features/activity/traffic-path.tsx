import { useTranslation } from "react-i18next"

import { Badge } from "@/components/ui/badge"
import type { ApiGatewayActivityEvent, AuditEvent, EndpointActivityEvent } from "@/domain/contracts"

export type TrafficPath = "BYPASS" | "DIRECT" | "SECURE_ACCESS" | "MANAGED_RESOURCE" | "BLOCK"

export const trafficPathLabels: Record<TrafficPath, string> = {
  BYPASS: "Bypass",
  DIRECT: "Direct",
  SECURE_ACCESS: "Secure Access",
  MANAGED_RESOURCE: "Managed Resource",
  BLOCK: "Block",
}

function isBlocked(outcome: string, route: "DIRECT" | "MANAGED" | "BLOCK" | null) {
  return route === "BLOCK" || outcome === "DENIED" || outcome === "BLOCKED" || outcome === "DENY"
}

export function apiGatewayTrafficPath(event: ApiGatewayActivityEvent): TrafficPath {
  return isBlocked(event.outcome, event.route) ? "BLOCK" : "MANAGED_RESOURCE"
}

export function governedGatewayTrafficPath(
  event: AuditEvent,
  lane: "ai" | "access",
): TrafficPath {
  if (isBlocked(event.outcome, event.route)) return "BLOCK"
  return lane === "ai" ? "MANAGED_RESOURCE" : "SECURE_ACCESS"
}

export function endpointTrafficPath(event: EndpointActivityEvent): TrafficPath {
  if (event.route === "BLOCK") return "BLOCK"
  return event.route === "DIRECT" ? "DIRECT" : "SECURE_ACCESS"
}

export function TrafficPathBadge({ path }: { path: TrafficPath }) {
  const { t } = useTranslation()
  const variant = path === "BLOCK" ? "destructive" : path === "DIRECT" ? "outline" : "secondary"
  return <Badge variant={variant}>{t(trafficPathLabels[path])}</Badge>
}
