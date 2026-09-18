import * as React from "react"
import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react"

import { Button } from "@/components/ui/button"
import { asChildProps } from "@/components/ui/slot"
import { cn } from "@/lib/utils"

function AlertDialog(props: React.ComponentProps<typeof AlertDialogPrimitive.Root>) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />
}

function AlertDialogTrigger({ asChild, children, ...props }: Omit<React.ComponentProps<typeof AlertDialogPrimitive.Trigger>, "render"> & { asChild?: boolean }) {
  return (
    <AlertDialogPrimitive.Trigger
      data-slot="alert-dialog-trigger"
      {...asChildProps(asChild, children)}
      {...props}
    />
  )
}

function AlertDialogPortal(props: React.ComponentProps<typeof AlertDialogPrimitive.Portal>) {
  return <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />
}

function AlertDialogOverlay({ className, ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Backdrop>) {
  return (
    <AlertDialogPrimitive.Backdrop
      data-slot="alert-dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className,
      )}
      {...props}
    />
  )
}

function AlertDialogContent({ className, ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Popup>) {
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Popup
        data-slot="alert-dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid w-full max-w-sm -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className,
        )}
        {...props}
      />
    </AlertDialogPortal>
  )
}

function AlertDialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert-dialog-header" className={cn("flex flex-col gap-1.5", className)} {...props} />
}

function AlertDialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn("-mx-4 -mb-4 flex justify-end gap-2 rounded-b-xl border-t bg-muted/50 p-4", className)}
      {...props}
    />
  )
}

function AlertDialogTitle({ className, ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return <AlertDialogPrimitive.Title data-slot="alert-dialog-title" className={cn("font-heading text-base font-medium", className)} {...props} />
}

function AlertDialogDescription({ className, ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return <AlertDialogPrimitive.Description data-slot="alert-dialog-description" className={cn("text-sm text-muted-foreground", className)} {...props} />
}

function AlertDialogAction({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Close> & Pick<React.ComponentProps<typeof Button>, "variant">) {
  return (
    <Button variant={variant} asChild>
      <AlertDialogPrimitive.Close data-slot="alert-dialog-action" className={cn(className)} {...props} />
    </Button>
  )
}

function AlertDialogCancel({ className, ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Close>) {
  return (
    <Button variant="outline" asChild>
      <AlertDialogPrimitive.Close data-slot="alert-dialog-cancel" className={cn(className)} {...props} />
    </Button>
  )
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
}
