"use client"

import * as React from "react"
import { type VariantProps } from "class-variance-authority"
import { Toggle as TogglePrimitive, ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react"

import { cn } from "@/lib/utils"
import { toggleVariants } from "@/components/ui/toggle"

const ToggleGroupContext = React.createContext<
  VariantProps<typeof toggleVariants> & {
    spacing?: number
    orientation?: "horizontal" | "vertical"
  }
>({
  size: "default",
  variant: "default",
  spacing: 2,
  orientation: "horizontal",
})

/**
 * Base UI models the group value as an array. The single-select form is kept
 * here so callers keep passing and receiving one value, which is how every
 * call site in the console uses it.
 */
function ToggleGroup({
  className,
  variant,
  size,
  spacing = 2,
  orientation = "horizontal",
  children,
  type = "single",
  value,
  onValueChange,
  ...props
}: Omit<React.ComponentProps<typeof ToggleGroupPrimitive>, "value" | "onValueChange"> &
  VariantProps<typeof toggleVariants> & {
    spacing?: number
    orientation?: "horizontal" | "vertical"
    type?: "single" | "multiple"
    value?: string | readonly string[]
    onValueChange?: (value: never) => void
  }) {
  const single = type === "single"
  const groupValue = value === undefined
    ? undefined
    : single
      ? (typeof value === "string" && value ? [value] : [])
      : (value as readonly string[])
  const handleValueChange = onValueChange
    ? (next: readonly string[]) =>
        (onValueChange as unknown as (selected: string | readonly string[]) => void)(
          single ? next[next.length - 1] ?? "" : next,
        )
    : undefined
  return (
    <ToggleGroupPrimitive
      value={groupValue}
      onValueChange={handleValueChange}
      data-slot="toggle-group"
      data-variant={variant}
      data-size={size}
      data-spacing={spacing}
      data-orientation={orientation}
      style={{ "--gap": spacing } as React.CSSProperties}
      className={cn(
        "group/toggle-group flex w-fit flex-row items-center gap-[--spacing(var(--gap))] rounded-lg data-[size=sm]:rounded-[min(var(--radius-md),10px)] data-vertical:flex-col data-vertical:items-stretch",
        className
      )}
      {...props}
    >
      <ToggleGroupContext.Provider
        value={{ variant, size, spacing, orientation }}
      >
        {children}
      </ToggleGroupContext.Provider>
    </ToggleGroupPrimitive>
  )
}

function ToggleGroupItem({
  className,
  children,
  variant = "default",
  size = "default",
  ...props
}: React.ComponentProps<typeof TogglePrimitive> &
  VariantProps<typeof toggleVariants>) {
  const context = React.useContext(ToggleGroupContext)

  return (
    <TogglePrimitive
      data-slot="toggle-group-item"
      data-variant={context.variant || variant}
      data-size={context.size || size}
      data-spacing={context.spacing}
      className={cn(
        "shrink-0 group-data-[spacing=0]/toggle-group:rounded-none group-data-[spacing=0]/toggle-group:px-2 focus:z-10 focus-visible:z-10 group-data-[spacing=0]/toggle-group:has-data-[icon=inline-end]:pr-1.5 group-data-[spacing=0]/toggle-group:has-data-[icon=inline-start]:pl-1.5 group-data-horizontal/toggle-group:data-[spacing=0]:first:rounded-l-lg group-data-vertical/toggle-group:data-[spacing=0]:first:rounded-t-lg group-data-horizontal/toggle-group:data-[spacing=0]:last:rounded-r-lg group-data-vertical/toggle-group:data-[spacing=0]:last:rounded-b-lg group-data-horizontal/toggle-group:data-[spacing=0]:data-[variant=outline]:border-l-0 group-data-vertical/toggle-group:data-[spacing=0]:data-[variant=outline]:border-t-0 group-data-horizontal/toggle-group:data-[spacing=0]:data-[variant=outline]:first:border-l group-data-vertical/toggle-group:data-[spacing=0]:data-[variant=outline]:first:border-t",
        toggleVariants({
          variant: context.variant || variant,
          size: context.size || size,
        }),
        className
      )}
      {...props}
    >
      {children}
    </TogglePrimitive>
  )
}

export { ToggleGroup, ToggleGroupItem }
