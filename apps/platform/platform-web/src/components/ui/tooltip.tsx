import * as React from "react"
import { Tooltip as TooltipPrimitive } from "@base-ui/react"

import { cn } from "@/lib/utils"

function TooltipProvider({
  delayDuration = 200,
  ...props
}: Omit<React.ComponentProps<typeof TooltipPrimitive.Provider>, "delay"> & {
  /** Base UI calls this delay; the existing name is kept for call sites. */
  delayDuration?: number
}) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delay={delayDuration}
      {...props}
    />
  )
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({
  asChild,
  children,
  ...props
}: Omit<React.ComponentProps<typeof TooltipPrimitive.Trigger>, "render"> & {
  asChild?: boolean
}) {
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      {...(asChild && React.isValidElement(children)
        ? { render: children as React.ReactElement }
        : { children })}
      {...props}
    />
  )
}

function TooltipContent({
  className,
  sideOffset = 0,
  side,
  align,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Popup> & {
  sideOffset?: number
  side?: React.ComponentProps<typeof TooltipPrimitive.Positioner>["side"]
  align?: React.ComponentProps<typeof TooltipPrimitive.Positioner>["align"]
}) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner align={align} side={side} sideOffset={sideOffset}>
      <TooltipPrimitive.Popup
        data-slot="tooltip-content"
        className={cn(
          "z-50 inline-flex w-fit max-w-xs origin-(--transform-origin) items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs text-background has-data-[slot=kbd]:pr-1.5 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground" />
      </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
