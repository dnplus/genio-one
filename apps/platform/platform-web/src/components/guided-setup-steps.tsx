import { CheckIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Item, ItemContent, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export type GuidedSetupStep = {
  id: string
  label: string
  description?: string
  status: "complete" | "current" | "upcoming"
}

export function GuidedSetupSteps({
  steps,
  activeStepId,
  onSelect,
  testId,
}: {
  steps: GuidedSetupStep[]
  activeStepId: string
  onSelect: (stepId: string) => void
  testId?: string
}) {
  return (
    <ItemGroup
      className="grid auto-cols-[minmax(8rem,1fr)] grid-flow-col gap-2 overflow-x-auto"
      data-testid={testId}
    >
      {steps.map((step, index) => (
        <div className="min-w-0" key={step.id} role="listitem">
          <Item
            size="sm"
            variant={step.id === activeStepId ? "outline" : step.status === "complete" ? "muted" : "default"}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  aria-current={step.id === activeStepId ? "step" : undefined}
                  aria-label={`${index + 1}. ${step.label}`}
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-md"
                  onClick={() => onSelect(step.id)}
                  type="button"
                >
                  <ItemMedia>
                    <Badge
                      className="size-6 shrink-0 justify-center rounded-full p-0"
                      variant={step.id === activeStepId ? "default" : "outline"}
                    >
                      {step.status === "complete" ? <CheckIcon /> : index + 1}
                    </Badge>
                  </ItemMedia>
                  <ItemContent className="flex min-w-0">
                    <ItemTitle className="w-full text-xs sm:text-sm">{step.label}</ItemTitle>
                  </ItemContent>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {step.description ?? step.label}
              </TooltipContent>
            </Tooltip>
          </Item>
        </div>
      ))}
    </ItemGroup>
  )
}
