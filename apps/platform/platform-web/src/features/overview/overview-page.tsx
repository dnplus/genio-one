import { RefreshCwIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import type { PageId } from "@/components/app-sidebar"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import type { OverviewSnapshot } from "@/domain/contracts"
import { AttentionList } from "@/features/overview/attention-list"
import { PlatformTopology, type AccessTier } from "@/features/overview/platform-topology"
import { SetupProgress } from "@/features/overview/setup-progress"
import { TransactionTrends } from "@/features/overview/transaction-trends"

interface OverviewPageProps {
  accessTier: AccessTier
  actorSubjectId: string
  tenantId: string
  data: OverviewSnapshot | null
  loading: boolean
  refreshing: boolean
  onRefresh: () => Promise<void>
  onOpenList: (page: PageId, filter?: string) => void
}

function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-5">
      <Skeleton className="h-10 w-52" />
      <Skeleton className="h-80 w-full" />
      <div className="grid gap-4 xl:grid-cols-[minmax(18rem,.8fr)_minmax(0,1.8fr)]">
        <div className="flex flex-col gap-4">
          <Skeleton className="h-72" />
          <Skeleton className="h-40" />
        </div>
        <Skeleton className="h-96" />
      </div>
    </div>
  )
}

export function OverviewPage({
  accessTier,
  actorSubjectId,
  tenantId,
  data,
  loading,
  refreshing,
  onRefresh,
  onOpenList,
}: OverviewPageProps) {
  const { t } = useTranslation()
  if (loading || !data) return <OverviewSkeleton />

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-[1.75rem]">{t("Overview")}</h1>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" onClick={() => void onRefresh()} disabled={refreshing}>
            <RefreshCwIcon data-icon="inline-start" className={refreshing ? "animate-spin" : undefined} />
            {t("Refresh")}
          </Button>
        </div>
      </div>

      <PlatformTopology accessTier={accessTier} data={data} onOpenList={onOpenList} />

      <div className="grid gap-5 xl:grid-cols-[minmax(20rem,.85fr)_minmax(0,1.7fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <AttentionList className="min-h-52 flex-1" data={data} onOpenList={onOpenList} />
          <SetupProgress actorSubjectId={actorSubjectId} tenantId={tenantId} data={data} onRefresh={onRefresh} />
        </div>
        <TransactionTrends tenantId={tenantId} data={data} onOpenActivity={(filter) => onOpenList("activity", filter)} />
      </div>
    </div>
  )
}
