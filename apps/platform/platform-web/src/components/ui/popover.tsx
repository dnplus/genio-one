import * as React from "react"
import { Popover as PopoverPrimitive } from "@base-ui/react"

import { asChildProps } from "@/components/ui/slot"
import { cn } from "@/lib/utils"

function Popover({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({
  asChild,
  children,
  ...props
}: Omit<React.ComponentProps<typeof PopoverPrimitive.Trigger>, "render"> & {
  asChild?: boolean
}) {
  return (
    <PopoverPrimitive.Trigger
      data-slot="popover-trigger"
      {...asChildProps(asChild, children)}
      {...props}
    />
  )
}

function PopoverContent({
  className,
  align = "center",
  side,
  collisionPadding,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Popup> & {
  align?: React.ComponentProps<typeof PopoverPrimitive.Positioner>["align"]
  side?: React.ComponentProps<typeof PopoverPrimitive.Positioner>["side"]
  collisionPadding?: React.ComponentProps<typeof PopoverPrimitive.Positioner>["collisionPadding"]
  sideOffset?: number
}) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner align={align} collisionPadding={collisionPadding} side={side} sideOffset={sideOffset}>
      <PopoverPrimitive.Popup
        data-slot="popover-content"
        className={cn(
          "z-50 flex w-72 origin-(--transform-origin) flex-col gap-2.5 rounded-lg bg-popover p-2.5 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
        {...props}
      />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

/** Base UI positions against the trigger; this keeps the export as a passthrough. */
function PopoverAnchor({ ...props }: React.ComponentProps<"div">) {
  return <div data-slot="popover-anchor" {...props} />
}

function PopoverHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="popover-header"
      className={cn("flex flex-col gap-0.5 text-sm", className)}
      {...props}
    />
  )
}

function PopoverTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <div
      data-slot="popover-title"
      className={cn("font-medium", className)}
      {...props}
    />
  )
}

function PopoverDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="popover-description"
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
}
