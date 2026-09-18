import * as React from "react"
import { Select as SelectPrimitive } from "@base-ui/react"

import { cn } from "@/lib/utils"
import { ChevronDownIcon, CheckIcon, ChevronUpIcon } from "lucide-react"

/**
 * Base UI types the value as unknown so a Select can carry any value. Every
 * call site here selects a string, so the wrapper pins it and keeps
 * onValueChange a plain (value: string) => void.
 */
function Select({
  onValueChange,
  ...props
}: Omit<React.ComponentProps<typeof SelectPrimitive.Root>, "value" | "defaultValue" | "onValueChange"> & {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
}) {
  return (
    <SelectPrimitive.Root
      data-slot="select"
      {...(onValueChange ? { onValueChange: (value: unknown) => onValueChange(String(value)) } : {})}
      {...props}
    />
  )
}

function SelectGroup({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return (
    <SelectPrimitive.Group
      data-slot="select-group"
      className={cn("scroll-my-1 p-1", className)}
      {...props}
    />
  )
}

function SelectValue({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />
}

function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
  size?: "sm" | "default"
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        "flex w-fit items-center justify-between gap-2 rounded-lg border border-input bg-background py-2 pr-3 pl-3 text-ui whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:outline-destructive data-placeholder:text-muted-foreground data-[size=default]:h-11 data-[size=sm]:h-11 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon
        render={<ChevronDownIcon className="pointer-events-none size-4 text-muted-foreground" />}
      />
    </SelectPrimitive.Trigger>
  )
}

function SelectContent({
  className,
  children,
  position = "item-aligned",
  align = "center",
  portalled = true,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Popup> & {
  portalled?: boolean
  position?: "item-aligned" | "popper"
  align?: React.ComponentProps<typeof SelectPrimitive.Positioner>["align"]
}) {
  const content = (
    <SelectPrimitive.Positioner align={align} alignItemWithTrigger={position === "item-aligned"}>
    <SelectPrimitive.Popup
        data-slot="select-content"
        data-align-trigger={position === "item-aligned"}
        className={cn("relative z-50 max-h-(--available-height) min-w-36 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg border bg-popover text-popover-foreground shadow-(--shadow-overlay) duration-100 data-[align-trigger=true]:animate-none data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95", position ==="popper"&&"data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1", className )}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.List
          data-position={position}
          className={cn(
            "data-[position=popper]:h-(--anchor-height) data-[position=popper]:w-full data-[position=popper]:min-w-(--anchor-width)",
            position === "popper" && ""
          )}
        >
          {children}
        </SelectPrimitive.List>
        <SelectScrollDownButton />
    </SelectPrimitive.Popup>
    </SelectPrimitive.Positioner>
  )
  return portalled ? <SelectPrimitive.Portal>{content}</SelectPrimitive.Portal> : content
}

function SelectLabel({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.GroupLabel>) {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-label"
      className={cn("px-1.5 py-1 text-xs text-muted-foreground", className)}
      {...props}
    />
  )
}

function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative flex min-h-11 w-full cursor-default items-center gap-1.5 rounded-sm py-1 pr-8 pl-1.5 text-ui outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
        className
      )}
      {...props}
    >
      <span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="pointer-events-none" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("pointer-events-none -mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  )
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpArrow>) {
  return (
    <SelectPrimitive.ScrollUpArrow
      data-slot="select-scroll-up-button"
      className={cn(
        "z-10 flex cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <ChevronUpIcon
      />
    </SelectPrimitive.ScrollUpArrow>
  )
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownArrow>) {
  return (
    <SelectPrimitive.ScrollDownArrow
      data-slot="select-scroll-down-button"
      className={cn(
        "z-10 flex cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <ChevronDownIcon
      />
    </SelectPrimitive.ScrollDownArrow>
  )
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
}
