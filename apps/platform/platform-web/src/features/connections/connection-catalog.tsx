import { useEffect, useState } from "react"
import { CableIcon, GlobeIcon, SparklesIcon, type LucideIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { ConnectionKind } from "@/domain/contracts"
import { defaultProviderEndpoints, type ProviderType } from "@/features/provider-credentials/provider-credential-strategy"

export type ConnectionCatalogId =
  | "servicenow-csm"
  | "mail2000"
  | "openai-compatible"
  | "anthropic"
  | "mcp"
  | "api"

export interface ConnectionCatalogItem {
  connectorKind?: "servicenow-csm" | "mail2000"
  id: ConnectionCatalogId
  kind: ConnectionKind
  providerType?: ProviderType
  label: string
  vendor: string
  description: string
  icon: LucideIcon
  endpoint?: string
}

export const connectionKinds: Array<{
  kind: ConnectionKind
  label: string
  description: string
  icon: LucideIcon
}> = [
  { kind: "LLM", label: "LLM Provider", description: "Hosted or local model endpoints.", icon: SparklesIcon },
  { kind: "MCP", label: "MCP server", description: "Model Context Protocol tools.", icon: CableIcon },
  { kind: "API", label: "API upstream", description: "OpenAPI-backed HTTP upstream.", icon: GlobeIcon },
]

export const connectionCatalog: ConnectionCatalogItem[] = [
  { id: "servicenow-csm", connectorKind: "servicenow-csm", kind: "MCP", label: "ServiceNow CSM", vendor: "Genio", description: "Configure a ServiceNow site; each user connects their own OAuth account.", icon: CableIcon },
  { id: "mail2000", connectorKind: "mail2000", kind: "MCP", label: "Mail2000", vendor: "Genio", description: "Configure mail, calendar and contacts; each user connects their own account.", icon: CableIcon },
  {
    id: "openai-compatible",
    kind: "LLM",
    providerType: "GENERIC_OPENAI_COMPATIBLE",
    label: "OpenAI-compatible",
    vendor: "OpenAI",
    description: "OpenAI, Ollama, OMLX, and other OpenAI-compatible HTTP endpoints.",
    icon: SparklesIcon,
    endpoint: defaultProviderEndpoints.OPENAI,
  },
  {
    id: "anthropic",
    kind: "LLM",
    providerType: "ANTHROPIC",
    label: "Anthropic-compatible",
    vendor: "Anthropic",
    description: "Anthropic Messages API and compatible endpoints.",
    icon: SparklesIcon,
    endpoint: defaultProviderEndpoints.ANTHROPIC,
  },
  {
    id: "mcp",
    kind: "MCP",
    label: "MCP server",
    vendor: "MCP",
    description: "Model Context Protocol tools.",
    icon: CableIcon,
  },
  {
    id: "api",
    kind: "API",
    label: "API upstream",
    vendor: "HTTP",
    description: "OpenAPI-backed HTTP upstream.",
    icon: GlobeIcon,
  },
]

export function ConnectionTypeCards({
  selectedId,
  allowedKinds,
  onSelect,
  onSelectKind,
}: {
  selectedId?: ConnectionCatalogId
  allowedKinds?: ConnectionKind[]
  onSelect: (item: ConnectionCatalogItem) => void
  onSelectKind?: (kind: ConnectionKind) => void
}) {
  const { t } = useTranslation()
  const kinds = (allowedKinds?.length ? connectionKinds.filter((entry) => allowedKinds.includes(entry.kind)) : connectionKinds)
  const selectedItem = connectionCatalog.find((item) => item.id === selectedId)
  const lockedKind = kinds.length === 1 ? kinds[0]!.kind : undefined
  const [kind, setKind] = useState<ConnectionKind | undefined>(selectedItem?.kind ?? lockedKind)
  const providers = connectionCatalog.filter((item) => item.kind === kind)
  const showKindPicker = kinds.length > 1

  useEffect(() => {
    if (!lockedKind || selectedId) return
    const matches = connectionCatalog.filter((item) => item.kind === lockedKind)
    if (matches.length === 1) onSelect(matches[0]!)
  }, [lockedKind, onSelect, selectedId])

  function chooseKind(next: ConnectionKind) {
    setKind(next)
    onSelectKind?.(next)
    const matches = connectionCatalog.filter((item) => item.kind === next)
    if (matches.length === 1) onSelect(matches[0]!)
  }

  return (
    <div className="flex flex-col gap-4" data-testid="connection-type-catalog">
      {showKindPicker ? (
        <div className="grid gap-3 sm:grid-cols-3">
          {kinds.map((entry) => {
            const Icon = entry.icon
            const selected = kind === entry.kind
            return (
              <Card key={entry.kind} className={selected ? "border-primary" : undefined}>
                <CardHeader className="flex flex-row items-start gap-3">
                  <div className="flex size-10 items-center justify-center rounded-lg border bg-muted">
                    <Icon />
                  </div>
                  <div className="min-w-0 flex-1">
                    <CardTitle>{t(entry.label)}</CardTitle>
                    <CardDescription>{t(entry.description)}</CardDescription>
                  </div>
                </CardHeader>
                <CardContent>
                  <Button onClick={() => chooseKind(entry.kind)} size="sm" type="button" variant={selected ? "default" : "outline"}>
                    {t("Select")}
                  </Button>
                </CardContent>
              </Card>
            )
          })}
        </div>
      ) : null}
      {kind && providers.length > 1 ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">{t("Choose a provider for this Connection type.")}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {providers.map((item) => {
              const Icon = item.icon
              const selected = item.id === selectedId
              return (
                <Card key={item.id} className={selected ? "border-primary" : undefined}>
                  <CardHeader className="flex flex-row items-start gap-3">
                    <div className="flex size-10 items-center justify-center rounded-lg border bg-muted">
                      <Icon />
                    </div>
                    <div className="min-w-0 flex-1">
                      <CardTitle>{t(item.label)}</CardTitle>
                      <CardDescription>{t(item.description)}</CardDescription>
                    </div>
                  </CardHeader>
                  <CardContent className="flex items-center justify-between gap-3">
                    <Badge variant="outline">{item.vendor}</Badge>
                    <Button onClick={() => onSelect(item)} size="sm" type="button" variant={selected ? "default" : "outline"}>
                      {t("Select")}
                    </Button>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        </div>
      ) : null}
    </div>
  )
}
