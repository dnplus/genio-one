import type { ReactNode } from "react"
import { ArrowLeftIcon } from "lucide-react"

import { Button } from "@/components/ui/button"

export function PageHeader({
  actions,
  backLabel,
  description,
  onBack,
  title,
}: {
  actions?: ReactNode
  backLabel?: string
  description?: ReactNode
  onBack?: () => void
  title: ReactNode
}) {
  return (
    <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
      <div className="flex min-w-0 items-center gap-3">
        {onBack ? (
          <Button aria-label={backLabel} className="shrink-0" onClick={onBack} size="icon" type="button" variant="outline">
            <ArrowLeftIcon />
          </Button>
        ) : null}
        <div className="min-w-0">
          <h1 className="text-[1.375rem] font-semibold tracking-tight sm:text-2xl">
            {title}
          </h1>
          {description ? <div className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</div> : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap justify-end gap-2">{actions}</div> : null}
    </div>
  )
}
