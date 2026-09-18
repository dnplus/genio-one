import * as React from "react"
import { useRender } from "@base-ui/react/use-render"

/**
 * Merges its props onto its single child instead of rendering an element.
 *
 * Base UI has no Slot component; it composes through a `render` prop. This
 * keeps the `asChild` spelling the component layer already uses so the call
 * sites do not change, while the behaviour comes from Base UI.
 */
export function Slot({
  children,
  ref,
  ...props
}: {
  children?: React.ReactNode
  ref?: React.Ref<HTMLElement>
} & Record<string, unknown>) {
  return useRender({
    render: children as React.ReactElement,
    props,
    ...(ref ? { ref } : {}),
  })
}

/**
 * Translates the `asChild` spelling into Base UI's `render` composition.
 * Spread onto a Base UI part so call sites can keep using `asChild`.
 */
export function asChildProps(
  asChild: boolean | undefined,
  children: React.ReactNode,
): { render: React.ReactElement } | { children: React.ReactNode } {
  return asChild && React.isValidElement(children)
    ? { render: children as React.ReactElement }
    : { children }
}
