import { CircleHelpIcon } from "lucide-react"
import type { ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

export function TitleHelp({
  children,
  className,
  help,
  label = "Help",
}: {
  children: ReactNode
  className?: string
  help?: ReactNode
  label?: string
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1", className)}>
      <span className="min-w-0">{children}</span>
      {help ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button aria-label={label} className="size-7 text-muted-foreground" size="icon-xs" type="button" variant="ghost">
              <CircleHelpIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm text-pretty" side="top" sideOffset={6}>
            {help}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </span>
  )
}
