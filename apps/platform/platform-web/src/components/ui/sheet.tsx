"use client"

import * as React from "react"
import { Dialog as SheetPrimitive } from "@base-ui/react"

import { asChildProps } from "@/components/ui/slot"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

const SheetWorkspaceContext = React.createContext<HTMLElement | null>(null)

function SheetWorkspaceRoot({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  const [container, setContainer] = React.useState<HTMLDivElement | null>(null)

  return (
    <div
      ref={setContainer}
      data-slot="sheet-workspace-root"
      className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden", className)}
    >
      <SheetWorkspaceContext.Provider value={container}>
        {children}
      </SheetWorkspaceContext.Provider>
    </div>
  )
}

function Sheet({ ...props }: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />
}

function SheetTrigger({ asChild, children, ...props }: Omit<React.ComponentProps<typeof SheetPrimitive.Trigger>, "render"> & { asChild?: boolean }) {
  return (
    <SheetPrimitive.Trigger
      data-slot="sheet-trigger"
      {...asChildProps(asChild, children)}
      {...props}
    />
  )
}

function SheetClose({ asChild, children, ...props }: Omit<React.ComponentProps<typeof SheetPrimitive.Close>, "render"> & { asChild?: boolean }) {
  return (
    <SheetPrimitive.Close
      data-slot="sheet-close"
      {...asChildProps(asChild, children)}
      {...props}
    />
  )
}

function SheetPortal({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Portal>) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />
}

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Backdrop>) {
  return (
    <SheetPrimitive.Backdrop
      data-slot="sheet-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/20 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

function SheetContent({
  className,
  children,
  side = "right",
  presentation = "workspace",
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Popup> & {
  side?: "top" | "right" | "bottom" | "left"
  presentation?: "workspace" | "workspace-panel" | "side"
  showCloseButton?: boolean
}) {
  const { t } = useTranslation()
  const workspaceContainer = React.useContext(SheetWorkspaceContext)
  const isWorkspace = presentation !== "side"
  return (
    <SheetPortal container={isWorkspace ? workspaceContainer : undefined}>
      <SheetOverlay className={isWorkspace ? "absolute" : undefined} />
      <SheetPrimitive.Popup
        data-slot="sheet-content"
        data-presentation={presentation}
        data-side={presentation === "side" ? side : presentation === "workspace-panel" ? "right" : undefined}
        className={cn(
          "fixed z-50 flex flex-col bg-popover bg-clip-padding text-sm text-popover-foreground transition duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
          presentation === "side" && "gap-4 shadow-(--shadow-overlay) data-[side=bottom]:inset-x-0 data-[side=bottom]:bottom-0 data-[side=bottom]:h-auto data-[side=bottom]:border-t data-[side=left]:inset-y-0 data-[side=left]:left-0 data-[side=left]:h-full data-[side=left]:w-3/4 data-[side=left]:border-r data-[side=right]:inset-y-0 data-[side=right]:right-0 data-[side=right]:h-full data-[side=right]:w-3/4 data-[side=right]:border-l data-[side=left]:sm:max-w-sm data-[side=right]:sm:max-w-sm data-[side=bottom]:data-open:slide-in-from-bottom-10 data-[side=left]:data-open:slide-in-from-left-10 data-[side=right]:data-open:slide-in-from-right-10 data-[side=top]:data-open:slide-in-from-top-10 data-[side=bottom]:data-closed:slide-out-to-bottom-10 data-[side=left]:data-closed:slide-out-to-left-10 data-[side=right]:data-closed:slide-out-to-right-10 data-[side=top]:data-closed:slide-out-to-top-10",
          className,
          presentation === "workspace" && "absolute inset-0 h-full w-full max-w-none overflow-hidden border-0 shadow-none sm:max-w-none md:max-w-none lg:max-w-none xl:max-w-none",
          presentation === "workspace-panel" && "absolute inset-y-0 right-0 h-full w-full max-w-none overflow-hidden border-l shadow-(--shadow-overlay) data-open:slide-in-from-right-10 data-closed:slide-out-to-right-10 sm:w-4/5 sm:max-w-none md:max-w-none lg:max-w-none xl:max-w-none"
        )}
        {...props}
      >
        {isWorkspace ? (
          <div data-slot="sheet-workspace-scroll" className="h-full w-full overflow-y-auto">
            <div data-slot="sheet-workspace" className="mx-auto flex min-h-full w-full max-w-[var(--go-content-max)] flex-col">
              {children}
            </div>
          </div>
        ) : children}
        {showCloseButton && (
          <SheetPrimitive.Close
            data-slot="sheet-close"
            render={
              <Button
                aria-label={t("Close")}
                variant="ghost"
                className={cn("absolute right-3", isWorkspace ? "top-4" : "top-3")}
                size="icon-sm"
              >
                <XIcon />
                <span className="sr-only">{t("Close")}</span>
              </Button>
            }
          />
        )}
      </SheetPrimitive.Popup>
    </SheetPortal>
  )
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-0.5 p-4", className)}
      {...props}
    />
  )
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("mt-auto flex flex-col gap-2 p-4", className)}
      {...props}
    />
  )
}

function SheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn(
        "font-heading text-base font-medium text-foreground",
        className
      )}
      {...props}
    />
  )
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
  SheetWorkspaceRoot,
}
