import type { MouseEvent } from "react"
import { useTranslation } from "react-i18next"

export function RelationValue({ id, label, reference, href, onClick }: {
  id: string
  label?: string | null
  reference?: string | null
  href?: string
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void
}) {
  const { t } = useTranslation()
  const primary = label && label !== "Unknown" && label !== id ? label : reference || t("Unresolved reference")
  return <div className="min-w-0" title={`${primary}\n${id}`}>
    {href ? <a className="block max-w-64 truncate font-medium text-[var(--link)] underline-offset-4 hover:underline" href={href}
      onClick={(event) => { event.stopPropagation(); onClick?.(event) }} onKeyDown={(event) => event.stopPropagation()}>{primary}</a>
      : <div className="max-w-64 truncate font-medium">{primary}</div>}
    {reference && reference !== primary ? <div className="truncate text-xs text-muted-foreground">{reference}</div> : null}
    <details className="text-xs text-muted-foreground" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      <summary className="cursor-pointer">{t("Technical ID")}</summary>
      <code className="block select-all break-all">{id}</code>
    </details>
  </div>
}
