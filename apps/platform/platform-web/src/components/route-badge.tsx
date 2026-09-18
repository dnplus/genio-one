import { useTranslation } from "react-i18next"

import { Badge } from "@/components/ui/badge"
import type { RouteDecision } from "@/domain/contracts"

export function RouteBadge({ route }: { route: RouteDecision }) {
  const { t } = useTranslation()
  const variant = route === "BLOCK" ? "destructive" : route === "MANAGED" ? "secondary" : "outline"
  return <Badge variant={variant}>{t(route)}</Badge>
}
