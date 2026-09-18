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
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
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
                  <ItemContent className="hidden sm:flex">
                    <ItemTitle>{step.label}</ItemTitle>
                  </ItemContent>
                </button>
              </TooltipTrigger>
              {step.description ? <TooltipContent side="bottom" sideOffset={6}>{step.description}</TooltipContent> : null}
            </Tooltip>
          </Item>
        </div>
      ))}
    </ItemGroup>
  )
}
