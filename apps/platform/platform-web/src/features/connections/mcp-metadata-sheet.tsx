import { useEffect, useMemo, useState } from "react"
import { EyeIcon, KeyRoundIcon, LoaderCircleIcon, RefreshCwIcon, UnplugIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import type { ConnectionSummary, McpDiscoveryOperation, McpOAuthBinding } from "@/domain/contracts"
import { formatEpochSeconds } from "@/lib/personal-preferences"
import { decideMcpDiscoveryCandidate, disconnectMcpOAuthBinding, getLatestMcpDiscovery, getMcpOAuthBinding, requestMcpDiscovery, startMcpOAuthAuthorization } from "@/lib/product-api"

export function McpMetadataSheet({
  tenantId,
  backend,
  editable,
  onUpdated,
}: {
  tenantId: string
  backend: ConnectionSummary
  editable: boolean
  onUpdated: () => Promise<void>
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [authorizing, setAuthorizing] = useState(false)
  const [operation, setOperation] = useState<McpDiscoveryOperation | null>(null)
  const [oauthBinding, setOauthBinding] = useState<McpOAuthBinding | null>(null)
  const [error, setError] = useState("")
  const [query, setQuery] = useState("")

  const metadata = operation?.observation ?? null
  const filteredTools = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!metadata) return []
    if (!normalized) return metadata.tools
    return metadata.tools.filter((tool) =>
      [tool.name, tool.title, tool.description]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLowerCase().includes(normalized)))
  }, [metadata, query])

  useEffect(() => {
    if (!open) return
    let active = true
    setQuery("")
    void Promise.all([
      getLatestMcpDiscovery(tenantId, backend.resource_id, backend.connection_id),
      backend.downstream_identity.mode === "USER_OAUTH"
        ? getMcpOAuthBinding(tenantId, backend.resource_id, backend.connection_id)
        : Promise.resolve(null),
    ])
      .then(([value, binding]) => {
        if (!active) return
        setOperation(value)
        setOauthBinding(binding)
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : "MCP_DISCOVERY_LOAD_FAILED")
      })
    return () => {
      active = false
    }
  }, [backend.connection_id, backend.downstream_identity.mode, backend.mcp_selected_tools, backend.mcp_tool_selection_operation_id, backend.resource_id, open, tenantId])

  async function authorize() {
    setAuthorizing(true)
    setError("")
    try {
      const authorization = await startMcpOAuthAuthorization(
        tenantId,
        backend.resource_id,
        backend.connection_id,
      )
      window.location.assign(authorization.authorization_url)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "MCP_OAUTH_DISCOVERY_FAILED")
      setAuthorizing(false)
    }
  }

  async function disconnect() {
    setAuthorizing(true)
    setError("")
    try {
      await disconnectMcpOAuthBinding(tenantId, backend.resource_id, backend.connection_id)
      setOauthBinding(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "MCP_OAUTH_DISCONNECT_FAILED")
    } finally {
      setAuthorizing(false)
    }
  }

  async function refresh() {
    setRefreshing(true)
    setError("")
    try {
      let current = await requestMcpDiscovery(tenantId, backend.resource_id, backend.connection_id)
      setOperation(current)
      const deadline = Date.now() + 20_000
      while ((current.state === "PENDING" || current.state === "RUNNING") && Date.now() < deadline) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
        current = await getLatestMcpDiscovery(tenantId, backend.resource_id, backend.connection_id) ?? current
        setOperation(current)
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "MCP_DISCOVERY_REQUEST_FAILED")
    } finally {
      setRefreshing(false)
    }
  }

  async function decideCandidate(candidateId: string, revisionDigest: string, state: "PUBLISHED" | "IGNORED" | "BLOCKED") {
    setSaving(true)
    setError("")
    try {
      const updated = await decideMcpDiscoveryCandidate(
        tenantId,
        backend.resource_id,
        backend.connection_id,
        candidateId,
        revisionDigest,
        state,
      )
      setOperation(updated)
      await onUpdated()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "MCP_DISCOVERY_CANDIDATE_DECISION_FAILED")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button size="sm" variant="outline">
          <EyeIcon data-icon="inline-start" />
          {t(editable ? "Configure MCP tools" : "View MCP tools")}
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <div className="flex min-h-full flex-col">
          <SheetHeader className="border-b px-6 py-5">
            <SheetTitle>{t(editable ? "Configure MCP tools" : "View MCP tools")}</SheetTitle>
            <SheetDescription>{backend.display_name} · {backend.connection_id}</SheetDescription>
          </SheetHeader>
          <FieldGroup className="p-6">
            {backend.downstream_identity.mode === "USER_OAUTH" ? (
              <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
                <div>
                  <div className="text-xs text-muted-foreground">{t("Upstream OAuth")}</div>
                  <div className="mt-1 font-medium">{t(oauthBinding ? "Connected" : "Authorization required")}</div>
                  {oauthBinding ? <div className="mt-1 text-xs text-muted-foreground">{oauthBinding.issuer}</div> : null}
                </div>
                {oauthBinding ? (
                  <Button type="button" variant="outline" onClick={() => void disconnect()} disabled={authorizing}>
                    <UnplugIcon data-icon="inline-start" />
                    {t("Disconnect")}
                  </Button>
                ) : (
                  <Button type="button" onClick={() => void authorize()} disabled={authorizing}>
                    {authorizing ? <LoaderCircleIcon data-icon="inline-start" className="animate-spin" /> : <KeyRoundIcon data-icon="inline-start" />}
                    {t("Authorize")}
                  </Button>
                )}
              </div>
            ) : null}
            <div className="flex items-center justify-between rounded-lg border bg-muted/20 p-4">
              <div>
                <div className="text-xs text-muted-foreground">{t("Discovery state")}</div>
                <div className="mt-1 font-medium">{operation ? t(operation.state) : t("Not requested")}</div>
              </div>
              <Badge variant={operation?.state === "SUCCEEDED" ? "secondary" : "outline"}>
                {operation ? t(operation.state) : t("Not requested")}
              </Badge>
            </div>
            <Field>
              <FieldLabel>{t("Discovery source")}</FieldLabel>
              <FieldDescription>
                {t("The Gateway Runtime discovers the upstream tool catalog. Select which tools this Connection publishes.")}
              </FieldDescription>
            </Field>
            {metadata ? (
              <>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <div className="rounded-lg border p-3">
                    <div className="text-xs text-muted-foreground">{t("Protocol version")}</div>
                    <div className="mt-1 font-mono text-sm">{metadata.protocol_version}</div>
                  </div>
                  <div className="rounded-lg border p-3">
                    <div className="text-xs text-muted-foreground">{t("Server name")}</div>
                    <div className="mt-1 text-sm">{metadata.server_name}</div>
                  </div>
                  <div className="rounded-lg border p-3">
                    <div className="text-xs text-muted-foreground">{t("Server version")}</div>
                    <div className="mt-1 font-mono text-sm">{metadata.server_version ?? "—"}</div>
                  </div>
                </div>
                <Field>
                  <div className="flex items-center justify-between gap-3">
                    <FieldLabel htmlFor={`mcp-tool-search-${backend.connection_id}`}>{t("Published tools")}</FieldLabel>
                    <Badge variant="outline">{t("{{count}} candidates", { count: metadata.tools.length })}</Badge>
                  </div>
                  <Input
                    id={`mcp-tool-search-${backend.connection_id}`}
                    placeholder={t("Search discovered tools")}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                  <div className="flex flex-col gap-2 rounded-lg border p-3">
                    {filteredTools.length ? filteredTools.map((tool) => {
                      const id = `mcp-tool-${backend.connection_id}-${tool.name}`
                      const candidate = operation?.candidates.find((value) => value.tool_name === tool.name)
                      return (
                        <Field key={tool.name} orientation="horizontal" className="items-start">
                          <FieldContent>
                            <FieldLabel className="font-mono" htmlFor={id}>{tool.name}</FieldLabel>
                            {tool.title || tool.description ? <FieldDescription>{tool.title ?? tool.description}</FieldDescription> : null}
                            {candidate ? <FieldDescription className="font-mono text-[11px]">{candidate.revision_digest}</FieldDescription> : null}
                          </FieldContent>
                          {candidate ? (
                            <div className="flex flex-wrap items-center justify-end gap-2">
                              <Badge variant={candidate.state === "PUBLISHED" ? "secondary" : "outline"}>{t(candidate.state)}</Badge>
                              {editable ? (
                                <>
                                  <Button type="button" size="sm" variant="outline" disabled={saving || candidate.state === "PUBLISHED"} onClick={() => void decideCandidate(candidate.candidate_id, candidate.revision_digest, "PUBLISHED")}>{t("Publish")}</Button>
                                  <Button type="button" size="sm" variant="outline" disabled={saving || candidate.state === "IGNORED"} onClick={() => void decideCandidate(candidate.candidate_id, candidate.revision_digest, "IGNORED")}>{t("Ignore")}</Button>
                                  <Button type="button" size="sm" variant="outline" disabled={saving || candidate.state === "BLOCKED"} onClick={() => void decideCandidate(candidate.candidate_id, candidate.revision_digest, "BLOCKED")}>{t("Block")}</Button>
                                </>
                              ) : null}
                            </div>
                          ) : null}
                        </Field>
                      )
                    }) : <div className="px-3 py-2 text-sm text-muted-foreground">{t(metadata.tools.length ? "No tools match your search" : "No tools discovered")}</div>}
                  </div>
                  <FieldDescription>{t("A discovery result never expands the active surface. Publish a candidate explicitly, then apply the staged successor Release.")}</FieldDescription>
                </Field>
                <FieldDescription>
                  {operation?.completed_at ? t("Synchronized at {{time}}", { time: formatEpochSeconds(operation.completed_at) }) : null}
                </FieldDescription>
              </>
            ) : (
              <div className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
                {operation?.state === "FAILED"
                  ? <div className="flex flex-col gap-1"><span>{t(operation.error_code ?? "MCP_DISCOVERY_FAILED")}</span>{operation.error_message ? <span className="text-xs">{operation.error_message}</span> : null}</div>
                  : t("Request discovery after the Connection endpoint and authentication are configured.")}
              </div>
            )}
            {error ? <FieldError>{t(error)}</FieldError> : null}
          </FieldGroup>
          <SheetFooter className="mt-auto border-t bg-background px-6 py-4">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>{t("Close")}</Button>
            <Button type="button" variant="outline" onClick={() => void refresh()} disabled={refreshing || saving || authorizing || (backend.downstream_identity.mode === "USER_OAUTH" && !oauthBinding)}>
              {refreshing ? <LoaderCircleIcon data-icon="inline-start" className="animate-spin" /> : <RefreshCwIcon data-icon="inline-start" />}
              {t(refreshing ? "Discovering…" : "Discover tools")}
            </Button>
          </SheetFooter>
        </div>
      </SheetContent>
    </Sheet>
  )
}
