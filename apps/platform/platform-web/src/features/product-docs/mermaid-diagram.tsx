import { useEffect, useId, useMemo, useRef, useState } from "react"
import mermaid, { type RenderResult } from "mermaid"
import { useTranslation } from "react-i18next"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"

let initialized = false

function initializeMermaid() {
  if (initialized) return
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "neutral",
    flowchart: { useMaxWidth: true },
  })
  initialized = true
}

export function MermaidDiagram({ chart }: { chart: string }) {
  const { t } = useTranslation()
  const reactId = useId()
  const diagramId = useMemo(
    () => `product-doc-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`,
    [reactId],
  )
  const containerRef = useRef<HTMLDivElement>(null)
  const [result, setResult] = useState<RenderResult | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    initializeMermaid()
    setResult(null)
    setFailed(false)

    void mermaid
      .render(diagramId, chart)
      .then((nextResult) => {
        if (!cancelled) setResult(nextResult)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })

    return () => {
      cancelled = true
    }
  }, [chart, diagramId])

  useEffect(() => {
    if (result && containerRef.current) result.bindFunctions?.(containerRef.current)
  }, [result])

  if (failed) {
    return (
      <Alert variant="destructive" className="my-5">
        <AlertTitle>{t("Diagram could not be rendered")}</AlertTitle>
        <AlertDescription>{t("Check the Mermaid source in this document.")}</AlertDescription>
      </Alert>
    )
  }

  return (
    <figure
      className="my-6 min-w-0 overflow-hidden rounded-lg border bg-muted/20 p-4"
      data-testid="product-document-diagram"
    >
      {result ? (
        <div
          ref={containerRef}
          aria-label={t("Product diagram")}
          className="w-full overflow-x-auto [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
          role="img"
          dangerouslySetInnerHTML={{ __html: result.svg }}
        />
      ) : (
        <Skeleton className="h-72 w-full" aria-label={t("Rendering diagram")} />
      )}
      <figcaption className="sr-only">{t("Product diagram")}</figcaption>
    </figure>
  )
}
