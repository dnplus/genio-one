import { useTranslation } from "react-i18next"

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"

export function ResourceContextTabs({
  active,
  onConnections,
  onOverview,
  showConnections = true,
}: {
  active: "overview" | "connections"
  onConnections?: () => void
  onOverview?: () => void
  showConnections?: boolean
}) {
  const { t } = useTranslation()
  return (
    <Tabs className="w-full" value={active}>
      <TabsList aria-label={t("Resource context") } variant="line">
        <TabsTrigger onClick={onOverview} value="overview">{t("Resource overview")}</TabsTrigger>
        {showConnections ? <TabsTrigger onClick={onConnections} value="connections">{t("Connections")}</TabsTrigger> : null}
      </TabsList>
    </Tabs>
  )
}
