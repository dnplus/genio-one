import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "@/components/ui/slot"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "group/button inline-flex min-h-11 shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-ui font-medium whitespace-nowrap outline-none select-none transition-[background-color,color,border-color,box-shadow] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:outline-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-[var(--primary-hover)] active:bg-[var(--primary-active)]",
        outline:
          "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        link: "text-[var(--link)] underline-offset-4 hover:underline",
      },
      size: {
        default:
          "gap-2 px-4 has-data-[icon=inline-end]:pr-3.5 has-data-[icon=inline-start]:pl-3.5",
        xs: "gap-1.5 px-2.5 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3.5",
        sm: "gap-1.5 px-3 text-ui in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        lg: "gap-2 px-5 text-base has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4",
        icon: "size-11",
        "icon-xs":
          "size-11 in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3.5",
        "icon-sm": "size-11 in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
