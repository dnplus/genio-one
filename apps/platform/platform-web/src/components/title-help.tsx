import { CircleHelpIcon } from "lucide-react"
import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

export function TitleHelp({
  children,
  className,
  help,
  label,
}: {
  children: ReactNode
  className?: string
  help?: ReactNode
  label?: string
}) {
  const { t } = useTranslation()
  const ariaLabel =
    label ??
    (typeof children === "string" && children.trim()
      ? t("Help for {{title}}", { title: children.trim() }).replace("{{title}}", children.trim())
      : t("Help"))

  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1", className)}>
      <span className="min-w-0">{children}</span>
      {help ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button aria-label={ariaLabel} className="size-7 text-muted-foreground" size="icon-xs" type="button" variant="ghost">
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
