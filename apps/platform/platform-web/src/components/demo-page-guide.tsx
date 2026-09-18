import { CompassIcon, EyeOffIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import {
  demoGuideDescriptions,
  demoGuideOrder,
  managementPageLabel,
  type PageId,
} from "@/components/management-navigation"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import type { AccessTier } from "@/features/overview/platform-topology"

interface DemoPageGuideProps {
  activePage: PageId
  tier: AccessTier
  onDismiss: () => void
  onNavigate: (page: PageId) => void
}

export function DemoPageGuide({ activePage, tier, onDismiss, onNavigate }: DemoPageGuideProps) {
  const { t } = useTranslation()
  const currentIndex = Math.max(0, demoGuideOrder.indexOf(activePage))
  const previousPage = demoGuideOrder[currentIndex - 1]
  const nextPage = demoGuideOrder[currentIndex + 1]
  const progress = ((currentIndex + 1) / demoGuideOrder.length) * 100

  return (
    <Alert className="mb-4" data-testid="demo-page-guide">
      <CompassIcon />
      <AlertTitle className="flex flex-wrap items-center gap-2">
        <span>{t("Demo guide: {{page}}", { page: t(managementPageLabel(activePage)) })}</span>
        <Badge variant="secondary">{t("Demo {{tier}}", { tier })}</Badge>
        <Badge variant="outline">
          {t("Step {{current}} of {{total}}", { current: currentIndex + 1, total: demoGuideOrder.length })}
        </Badge>
      </AlertTitle>
      <AlertDescription className="flex flex-col gap-3">
        <p>{t(demoGuideDescriptions[activePage])}</p>
        <Progress aria-label={t("Demo guide progress")} value={progress} />
        <div className="flex flex-wrap gap-2">
          <Button disabled={!previousPage} onClick={() => previousPage && onNavigate(previousPage)} size="sm" variant="outline">
            {t("Previous")}
          </Button>
          <Button disabled={!nextPage} onClick={() => nextPage && onNavigate(nextPage)} size="sm" variant="outline">
            {t("Next")}
          </Button>
          <Button onClick={onDismiss} size="sm" variant="ghost">
            <EyeOffIcon data-icon="inline-start" />
            {t("Hide guide")}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  )
}
