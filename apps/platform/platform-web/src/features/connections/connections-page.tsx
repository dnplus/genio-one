import { ConnectorFields, emptyConnectorConfiguration } from "./connector-fields"
import type { ConnectorConfiguration } from "@/domain/contracts"
import { ConnectionTestPanel } from "./connection-test-panel"
import { RelationValue } from "@/components/relation-value"
import { useRecordSelection } from "@/hooks/use-record-selection"
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react"
import { createColumnHelper } from "@tanstack/react-table"
import { CheckCircle2Icon, GaugeIcon, LoaderCircleIcon, MoreHorizontalIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { DataEmpty } from "@/components/data-empty"
import { DataTable } from "@/components/data-table/data-table"
import type { DataTableFeatures } from "@/components/data-table/data-table-features"
import { PageHeader } from "@/components/page-header"
import { TitleHelp } from "@/components/title-help"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { SearchableSelect } from "@/components/ui/searchable-select"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import type {
  ConnectionSummary,
  InstallationServiceKind,
  ProviderCredentialProfileRevision,
  ResourceRegistration,
  RuntimeInventoryEntry,
  UpstreamResiliencyPolicy,
} from "@/domain/contracts"
import { ApiRequestMappingSheet } from "@/features/connections/api-request-mapping-sheet"
import { ConnectionCertificateSheet } from "@/features/connections/connection-certificate-sheet"
import { CreateConnectionWizard } from "@/features/connections/create-connection-wizard"
import { McpMetadataSheet } from "@/features/connections/mcp-metadata-sheet"
import { ResourceContextTabs } from "@/features/resources/resource-context-tabs"
import { connectionInventoryVisibility, hasPendingPublication } from "@/features/resources/resource-administration"
import { deleteResourceConnection, listProviderCredentialProfiles, transitionResourceConnectionLifecycle, updateConnectionMcpRouting, updateResourceConnection, verifyResourceConnection } from "@/lib/product-api"

export type ResiliencyForm = {
  timeoutMs: string
  maxAttempts: string
  idempotencyHeader: string
  circuitFailureThreshold: string
  circuitOpenMs: string
}

export const defaultResiliency: ResiliencyForm = {
  timeoutMs: "30000",
  maxAttempts: "1",
  idempotencyHeader: "",
  circuitFailureThreshold: "5",
  circuitOpenMs: "30000",
}

function boundedInteger(value: string, min: number, max: number) {
  const parsed = Number(value.trim())
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : undefined
}

function isOwnedIdempotencyHeader(value: string) {
  const header = value.trim()
  return (
    header.length > 0 &&
    header.length <= 64 &&
    (header === "idempotency-key" || header.endsWith("-idempotency-key")) &&
    /^[a-z0-9-]+$/.test(header)
  )
}

export function resiliencyFromForm(form: ResiliencyForm): { policy?: UpstreamResiliencyPolicy; error?: string } {
  const timeoutMs = boundedInteger(form.timeoutMs, 1, 120_000)
  if (timeoutMs === undefined) {
    return { error: "Upstream timeout must be an integer between 1 and 120000 ms." }
  }
  const maxAttempts = boundedInteger(form.maxAttempts, 1, 3)
  if (maxAttempts === undefined) {
    return { error: "Maximum attempts must be an integer between 1 and 3." }
  }
  const circuitFailureThreshold = boundedInteger(form.circuitFailureThreshold, 1, 100)
  if (circuitFailureThreshold === undefined) {
    return { error: "Circuit failure threshold must be an integer between 1 and 100." }
  }
  const circuitOpenMs = boundedInteger(form.circuitOpenMs, 1, 300_000)
  if (circuitOpenMs === undefined) {
    return { error: "Circuit open time must be an integer between 1 and 300000 ms." }
  }

  const idempotencyHeader = form.idempotencyHeader.trim()
  if (idempotencyHeader && !isOwnedIdempotencyHeader(idempotencyHeader)) {
    return { error: "Idempotency header must be idempotency-key or a lowercase *-idempotency-key." }
  }
  if (maxAttempts > 1 && !isOwnedIdempotencyHeader(idempotencyHeader)) {
    return { error: "Retries above 1 require an owned idempotency header contract." }
  }

  return {
    policy: {
      timeout_ms: timeoutMs,
      max_attempts: maxAttempts,
      idempotency_header: idempotencyHeader || null,
      circuit_failure_threshold: circuitFailureThreshold,
      circuit_open_ms: circuitOpenMs,
    },
  }
}

export function ResiliencyFields({
  form,
  onChange,
}: {
  form: ResiliencyForm
  onChange: (next: ResiliencyForm) => void
}) {
  const { t } = useTranslation()
  function update<Key extends keyof ResiliencyForm>(key: Key, value: ResiliencyForm[Key]) {
    onChange({ ...form, [key]: value })
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h3 className="text-sm font-medium">{t("Upstream resiliency")}</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("Timeout and circuit settings apply to each upstream attempt. Retries are enabled only when the upstream owns an idempotency contract.")}
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="connection-timeout-ms">{t("Upstream timeout (ms)")}</FieldLabel>
          <Input
            id="connection-timeout-ms"
            inputMode="numeric"
            min={1}
            max={120000}
            type="number"
            value={form.timeoutMs}
            onChange={(event) => update("timeoutMs", event.target.value)}
            required
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="connection-max-attempts">{t("Maximum attempts")}</FieldLabel>
          <Input
            id="connection-max-attempts"
            inputMode="numeric"
            min={1}
            max={3}
            type="number"
            value={form.maxAttempts}
            onChange={(event) => update("maxAttempts", event.target.value)}
            required
          />
          <FieldDescription>{t("Set above 1 only when the upstream contract supports idempotency.")}</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="connection-idempotency-header">{t("Owned idempotency header")}</FieldLabel>
          <Input
            id="connection-idempotency-header"
            value={form.idempotencyHeader}
            onChange={(event) => update("idempotencyHeader", event.target.value)}
            placeholder="idempotency-key"
            pattern="[a-z0-9-]+"
          />
          <FieldDescription>{t("Use idempotency-key or a lowercase vendor-idempotency-key. The Gateway owns the value.")}</FieldDescription>
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="connection-circuit-failure-threshold">{t("Circuit failure threshold")}</FieldLabel>
          <Input
            id="connection-circuit-failure-threshold"
            inputMode="numeric"
            min={1}
            max={100}
            type="number"
            value={form.circuitFailureThreshold}
            onChange={(event) => update("circuitFailureThreshold", event.target.value)}
            required
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="connection-circuit-open-ms">{t("Circuit open time (ms)")}</FieldLabel>
          <Input
            id="connection-circuit-open-ms"
            inputMode="numeric"
            min={1}
            max={300000}
            type="number"
            value={form.circuitOpenMs}
            onChange={(event) => update("circuitOpenMs", event.target.value)}
            required
          />
        </Field>
      </div>
    </div>
  )
}

export function RegisterConnectionSheet({ tenantId, resources, onRegistered, defaultResourceId, defaultOpen = false, trigger }: {
  tenantId: string
  resources: ResourceRegistration[]
  onRegistered: () => Promise<void>
  defaultResourceId?: string
  defaultOpen?: boolean
  trigger?: ReactNode
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(defaultOpen)
  return <Sheet open={open} onOpenChange={setOpen}>
    <SheetTrigger asChild>{trigger ?? <Button variant="outline">{t("Add Connection")}</Button>}</SheetTrigger>
    <SheetContent className="w-full overflow-y-auto sm:max-w-5xl" data-testid="connection-register-wizard">
      <SheetHeader><SheetTitle>{t("Add Connection")}</SheetTitle><SheetDescription>{t("Choose a provider and configure a Resource-owned Connection.")}</SheetDescription></SheetHeader>
      <CreateConnectionWizard tenantId={tenantId} resources={resources} defaultResourceId={defaultResourceId} onCancel={() => setOpen(false)} onCreated={async (connectionId) => { await onRegistered(); setOpen(false); window.location.assign(`?view=connections&connection=${encodeURIComponent(connectionId)}`) }} />
    </SheetContent>
  </Sheet>
}

function McpRoutingSheet({
  tenantId,
  backend,
  onUpdated,
}: {
  tenantId: string
  backend: ConnectionSummary
  onUpdated: () => Promise<void>
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [namespace, setNamespace] = useState(backend.mcp_tool_namespace ?? "")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")

  function changeOpen(next: boolean) {
    setOpen(next)
    if (next) setNamespace(backend.mcp_tool_namespace ?? "")
    if (!next) setError("")
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitting(true)
    setError("")
    try {
      await updateConnectionMcpRouting(tenantId, backend.resource_id, backend.connection_id, backend.configuration_revision, namespace)
      await onUpdated()
      setOpen(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("MCP routing update failed"))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={changeOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm" data-testid={`configure-mcp-routing-${backend.connection_id}`}>
          <PencilIcon data-icon="inline-start" />
          {t("Configure MCP routing")}
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full sm:max-w-xl">
        <form className="flex min-h-full flex-col" onSubmit={submit}>
          <SheetHeader className="border-b px-6 py-5">
            <SheetTitle>{t("Configure MCP routing")}</SheetTitle>
            <SheetDescription>{backend.display_name} · {backend.connection_id}</SheetDescription>
          </SheetHeader>
          <FieldGroup className="p-6">
            <Field>
              <FieldLabel htmlFor="mcp-routing-namespace">{t("MCP tool namespace")}</FieldLabel>
              <Input
                id="mcp-routing-namespace"
                value={namespace}
                onChange={(event) => setNamespace(event.target.value)}
                placeholder={t("engineering")}
              />
              <FieldDescription>{t("Optional stable namespace for federated MCP tool names.")}</FieldDescription>
            </Field>
            {error ? <FieldError>{t(error)}</FieldError> : null}
          </FieldGroup>
          <SheetFooter className="mt-auto border-t bg-background px-6 py-4">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>{t("Cancel")}</Button>
            <Button type="submit" data-testid={`save-mcp-routing-${backend.connection_id}`} disabled={submitting}>
              {submitting ? <LoaderCircleIcon data-icon="inline-start" className="animate-spin" /> : null}
              {t(submitting ? "Saving…" : "Save MCP routing")}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}

function EditConnectionSheet({
  tenantId,
  connection,
  serviceKind,
  ownerOrganizationId,
  open,
  onOpenChange,
  onUpdated,
}: {
  tenantId: string
  connection: ConnectionSummary | null
  serviceKind?: InstallationServiceKind | null
  ownerOrganizationId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onUpdated: () => Promise<void>
}) {
  const { t } = useTranslation()
  const sheetContentRef = useRef<HTMLDivElement>(null)
  const [connectorConfiguration, setConnectorConfiguration] = useState<ConnectorConfiguration | undefined>()
  const [displayName, setDisplayName] = useState("")
  const [endpointUrl, setEndpointUrl] = useState("")
  const [routingPriority, setRoutingPriority] = useState("0")
  const [region, setRegion] = useState("")
  const [supportedObligations, setSupportedObligations] = useState("")
  const [providerCredentialProfiles, setProviderCredentialProfiles] = useState<ProviderCredentialProfileRevision[]>([])
  const [providerCredentialProfileKey, setProviderCredentialProfileKey] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!connection) return
    const installedConfiguration = !connection.connector_configuration && serviceKind === "SERVICENOW_CSM"
      ? emptyConnectorConfiguration("servicenow-csm")
      : !connection.connector_configuration && serviceKind === "MAIL2000"
        ? emptyConnectorConfiguration("mail2000")
        : undefined
    setConnectorConfiguration(connection.connector_configuration ?? installedConfiguration)
    setDisplayName(connection.display_name)
    setEndpointUrl(connection.endpoint_url)
    setRoutingPriority(String(connection.routing_priority))
    setRegion(connection.region ?? "")
    setSupportedObligations(connection.supported_obligations.join(", "))
    setProviderCredentialProfileKey(connection.provider_credential_profile
      ? `${connection.provider_credential_profile.profile_id}:${connection.provider_credential_profile.revision}`
      : "")
    setError("")
  }, [connection, serviceKind])

  useEffect(() => {
    if (!open || connection?.kind !== "LLM") return
    void listProviderCredentialProfiles(tenantId)
      .then((profiles) => setProviderCredentialProfiles(profiles.filter((profile) => profile.state === "ACTIVE")))
      .catch((caught) => setError(caught instanceof Error ? caught.message : t("Provider credential profiles could not be loaded.")))
  }, [connection?.kind, open, tenantId, t])

  const eligibleProviderCredentialProfiles = providerCredentialProfiles.filter((profile) =>
    profile.owner_organization_id === ownerOrganizationId &&
    (connection?.llm?.provider_id !== "GCP_VERTEX_AI" || profile.adapter_family === "GCP"))
  const selectedProviderCredentialProfile = eligibleProviderCredentialProfiles.find((profile) =>
    `${profile.profile_id}:${profile.revision}` === providerCredentialProfileKey)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!connection) return
    if (connection.kind === "LLM" && !selectedProviderCredentialProfile) {
      setError(t("Select an active Provider Credential Profile owned by the Resource Organization."))
      return
    }
    setSubmitting(true)
    setError("")
    try {
      await updateResourceConnection(tenantId, {
        resourceId: connection.resource_id,
        connectionId: connection.connection_id,
        expectedRevision: connection.configuration_revision,
        displayName: displayName.trim(),
        ...(connectorConfiguration ? { connectorConfiguration } : { endpointUrl: endpointUrl.trim() }),
        routingPriority: Number(routingPriority),
        region: region.trim() || null,
        supportedObligations: [...new Set(supportedObligations.split(",").map((value) => value.trim()).filter(Boolean))],
        ...(connection.kind === "LLM"
          ? { providerCredentialProfile: selectedProviderCredentialProfile
            ? { profile_id: selectedProviderCredentialProfile.profile_id, revision: selectedProviderCredentialProfile.revision }
            : null }
          : {}),
      })
      await onUpdated()
      onOpenChange(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Connection update failed"))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent ref={sheetContentRef} className="w-full sm:max-w-xl" data-testid="connection-edit-sheet">
        <form className="flex min-h-full flex-col" onSubmit={submit}>
          <SheetHeader className="border-b px-6 py-5">
            <SheetTitle>{t("Edit Connection")}</SheetTitle>
            <SheetDescription>{connection?.display_name}</SheetDescription>
          </SheetHeader>
          <FieldGroup className="p-6">
            <Field>
              <FieldLabel htmlFor="edit-connection-display-name">{t("Display name")}</FieldLabel>
              <Input
                id="edit-connection-display-name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                required
              />
            </Field>
            {connectorConfiguration ? <ConnectorFields key={connection?.connection_id} value={connectorConfiguration} onChange={setConnectorConfiguration} /> : (
            <Field>
              <FieldLabel htmlFor="edit-connection-endpoint">{t("Upstream endpoint URL")}</FieldLabel>
              <Input
                id="edit-connection-endpoint"
                type="url"
                value={endpointUrl}
                onChange={(event) => setEndpointUrl(event.target.value)}
                required
              />
            </Field>
            )}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="edit-connection-priority">{t("Routing priority")}</FieldLabel>
                <Input id="edit-connection-priority" type="number" min={0} max={1000} value={routingPriority} onChange={(event) => setRoutingPriority(event.target.value)} required />
              </Field>
              <Field>
                <FieldLabel htmlFor="edit-connection-region">{t("Region")}</FieldLabel>
                <Input id="edit-connection-region" value={region} onChange={(event) => setRegion(event.target.value)} />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="edit-connection-obligations">{t("Supported obligations")}</FieldLabel>
              <Input id="edit-connection-obligations" value={supportedObligations} onChange={(event) => setSupportedObligations(event.target.value)} placeholder={t("data.redact, audit.receipt")} />
              <FieldDescription>{t("Comma-separated mandatory obligation kinds this Connection can enforce.")}</FieldDescription>
            </Field>
            {connection?.kind === "LLM" ? (
              <Field data-invalid={Boolean(error)}>
                <FieldLabel>{t("Provider Credential Profile")}</FieldLabel>
                <SearchableSelect
                  portalContainer={sheetContentRef}
                  value={providerCredentialProfileKey}
                  options={eligibleProviderCredentialProfiles.map((profile) => ({
                    value: `${profile.profile_id}:${profile.revision}`,
                    label: profile.display_name,
                    description: `${profile.strategy.kind} · revision ${profile.revision}`,
                    searchText: `${profile.profile_id} ${profile.adapter_family}`,
                  }))}
                  onValueChange={setProviderCredentialProfileKey}
                  placeholder={t("Select a Provider Credential Profile")}
                  searchPlaceholder={t("Search Provider Credential Profiles")}
                  emptyLabel={t("No active profiles are available for this Resource Organization.")}
                />
                <FieldDescription>{t("Changing the immutable credential revision requires Connection verification and a successor Runtime release.")}</FieldDescription>
              </Field>
            ) : null}
            {error ? <FieldError>{t(error)}</FieldError> : null}
          </FieldGroup>
          <SheetFooter className="mt-auto border-t bg-background px-6 py-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t("Cancel")}</Button>
            <Button type="submit" disabled={submitting || !displayName.trim() || (!connectorConfiguration && !endpointUrl.trim())}>{t(submitting ? "Saving…" : "Save Connection")}</Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}

type ConnectionRow = {
  connection: ConnectionSummary
  resourceName: string
  kind: ConnectionSummary["kind"]
  lifecycle: ConnectionSummary["lifecycle"]
  health: ConnectionSummary["health_state"]
  ownerOrganization: string
  visibility: "ACTIVE" | "EXITING" | "ARCHIVED"
}

const connectionColumnHelper = createColumnHelper<DataTableFeatures, ConnectionRow>()

function appliedReleaseRevision(
  resource: ResourceRegistration | undefined,
  runtimes: RuntimeInventoryEntry[],
) {
  const gatewayId = resource?.publication_endpoint?.gateway_id
  const gatewayRuntimes = runtimes.filter((runtime) =>
    runtime.runtime_kind === "GATEWAY" &&
    runtime.gateway_id === gatewayId &&
    runtime.release_eligible,
  )
  const revisions = gatewayRuntimes.map((runtime) => {
    if (!runtime.in_sync || runtime.last_successful_state_revision === null) return null
    const parsed = Number(runtime.last_successful_state_revision)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
  })
  return gatewayRuntimes.length > 0 && revisions.every((revision) => revision !== null)
    ? Math.min(...revisions as number[])
    : null
}

export function ConnectionsPage({
  tenantId,
  resources,
  connections,
  runtimes,
  focusedResourceId,
  onRefresh,
  onOpenResource,
}: {
  tenantId: string
  resources: ResourceRegistration[]
  connections: ConnectionSummary[]
  runtimes: RuntimeInventoryEntry[]
  focusedResourceId?: string | null
  onRefresh: () => Promise<void>
  onOpenResource?: (resourceId: string) => void
}) {
  const { t } = useTranslation()
  const [createOpen] = useState(() => new URLSearchParams(window.location.search).get("create") === "1")
  const [creating, setCreatingState] = useState(createOpen)
  function setCreating(value: boolean) {
    setCreatingState(value)
    const url = new URL(window.location.href)
    if (value) url.searchParams.set("create", "1")
    else url.searchParams.delete("create")
    window.history.replaceState(window.history.state, "", url)
  }
  const [workingConnections, setWorkingConnections] = useState(connections)
  const [selectedConnectionId, setSelectedConnectionId] = useRecordSelection("connection")
  const [editingConnection, setEditingConnection] = useState<ConnectionSummary | null>(null)
  const [deletingConnection, setDeletingConnection] = useState<ConnectionSummary | null>(null)
  const [credentialProfiles, setCredentialProfiles] = useState<ProviderCredentialProfileRevision[]>([])
  const [actionError, setActionError] = useState("")
  const [actionFeedback, setActionFeedback] = useState("")
  const [actionBusy, setActionBusy] = useState(false)
  useEffect(() => {
    setActionError("")
    setActionFeedback("")
  }, [selectedConnectionId])
  useEffect(() => {
    let active = true
    void listProviderCredentialProfiles(tenantId).then((profiles) => { if (active) setCredentialProfiles(profiles) }).catch(() => {})
    return () => { active = false }
  }, [tenantId])
  async function runAction(action: () => Promise<unknown>) {
    setActionError("")
    setActionFeedback("")
    setActionBusy(true)
    try { await action(); await onRefresh() }
    catch (caught) { setActionError(caught instanceof Error ? caught.message : "CONNECTION_UPDATE_FAILED") }
    finally { setActionBusy(false) }
  }


  useEffect(() => {
    setWorkingConnections(connections)
  }, [connections])

  const resourcesById = useMemo(
    () => new Map(resources.map((resource) => [resource.resource_id, resource])),
    [resources],
  )
  const visibleConnections = focusedResourceId
    ? workingConnections.filter((backend) => backend.resource_id === focusedResourceId)
    : workingConnections
  const focusedResource = focusedResourceId ? resourcesById.get(focusedResourceId) : null
  const connectionRows = useMemo<ConnectionRow[]>(() => visibleConnections.map((connection) => {
    const resource = resourcesById.get(connection.resource_id)
    return {
      connection,
      resourceName: resource?.display_name ?? connection.resource_id,
      kind: connection.kind,
      lifecycle: connection.lifecycle,
      health: connection.health_state,
      ownerOrganization: resource?.owner_organization_id ?? "",
      visibility: connectionInventoryVisibility(connection.lifecycle),
    }
  }), [resourcesById, visibleConnections])
  const connectionColumns = useMemo(() => connectionColumnHelper.columns([
    connectionColumnHelper.accessor((row) => row.connection.display_name, {
      id: "connection",
      header: t("Connection"),
      cell: ({ getValue }) => <span className="font-medium">{getValue()}</span>,
    }),
    connectionColumnHelper.accessor("resourceName", {
      header: t("Resource"),
      cell: ({ row }) => <RelationValue id={row.original.connection.resource_id} label={row.original.resourceName} href={`?view=resources&resource=${encodeURIComponent(row.original.connection.resource_id)}`} />,
    }),
    connectionColumnHelper.accessor((row) => (row.connection.connector_configuration ? row.connection.connector_configuration.kind === "servicenow-csm" ? row.connection.connector_configuration.instance_url : row.connection.connector_configuration.imap_host : row.connection.endpoint_url), {
      id: "endpoint",
      header: t("Endpoint"),
      cell: ({ getValue }) => <span className="font-mono text-xs">{getValue()}</span>,
    }),
    connectionColumnHelper.accessor("visibility", {
      header: t("Visibility"),
      cell: ({ getValue }) => t(getValue() === "ARCHIVED" ? "Archived" : "In use"),
      filterFn: "includesString",
    }),
    connectionColumnHelper.accessor("kind", {
      header: t("Type"),
      cell: ({ getValue }) => <Badge variant="outline">{getValue()}</Badge>,
      filterFn: "includesString",
    }),
    connectionColumnHelper.accessor("lifecycle", {
      header: t("State"),
      cell: ({ getValue }) => <Badge variant={getValue() === "ENABLED" ? "secondary" : "outline"}>{t(getValue())}</Badge>,
      filterFn: "includesString",
    }),
    connectionColumnHelper.accessor("health", {
      header: t("Health"),
      cell: ({ getValue }) => t(getValue()),
    }),
  ]), [t])
  const selectedConnection = selectedConnectionId
    ? visibleConnections.find((connection) => connection.connection_id === selectedConnectionId)
      ?? workingConnections.find((connection) => connection.connection_id === selectedConnectionId)
      ?? null
    : null
  const selectedResource = selectedConnection ? resourcesById.get(selectedConnection.resource_id) : undefined
  const selectedReleaseRevision = appliedReleaseRevision(selectedResource, runtimes)
  const canDeleteSelected = !selectedResource?.installation_owned && selectedResource?.lifecycle === "DRAFT"
  const canConfirmRevoke = selectedConnection
    ? selectedReleaseRevision !== null &&
      selectedReleaseRevision > (selectedConnection.revoke_requested_after_release_revision ?? Number.MAX_SAFE_INTEGER)
    : false

  async function runLifecycle(command: "ENABLE" | "DISABLE" | "REQUEST_REVOKE" | "CONFIRM_REVOKED") {
    if (!selectedConnection) return
    await transitionResourceConnectionLifecycle(tenantId, {
      resourceId: selectedConnection.resource_id,
      connectionId: selectedConnection.connection_id,
      expectedRevision: selectedConnection.configuration_revision,
      command,
      ...(command === "CONFIRM_REVOKED" && selectedReleaseRevision !== null
        ? { appliedReleaseRevision: selectedReleaseRevision }
        : {}),
    })
    await onRefresh()
  }

  async function deleteConnection() {
    if (!deletingConnection) return
    await deleteResourceConnection(tenantId, deletingConnection.resource_id, deletingConnection.connection_id)
    await onRefresh()
    setDeletingConnection(null)
  }

  if (selectedConnection) {
    const backend = selectedConnection
    const resource = selectedResource
    const canDelete = canDeleteSelected
    const configurationRequired = resource?.installation_owned &&
      (resource.service_kind === "SERVICENOW_CSM" || resource.service_kind === "MAIL2000") &&
      !backend.connector_configuration
    const personalCredentialMode = backend.downstream_identity.mode === "USER_PASSWORD" || backend.downstream_identity.mode === "USER_OAUTH"
    const endpoint = backend.connector_configuration
      ? backend.connector_configuration.kind === "servicenow-csm"
        ? backend.connector_configuration.instance_url
        : backend.connector_configuration.imap_host
      : backend.endpoint_url
    return (
      <div className="flex flex-col gap-5" data-testid="connection-detail-page">
        <PageHeader
          actions={resource?.builtin_service ? <>
            <Badge variant="secondary">{t("Built-in MCP")}</Badge>
            {backend.verification_state === "VERIFIED" && backend.lifecycle === "DISABLED" ? (
              <Button disabled={actionBusy} variant="outline" onClick={() => void runAction(() => runLifecycle("ENABLE"))}>{t("Enable")}</Button>
            ) : null}
            {backend.lifecycle === "ENABLED" ? (
              <Button disabled={actionBusy} variant="outline" onClick={() => void runAction(() => runLifecycle("DISABLE"))}>{t("Disable")}</Button>
            ) : null}
          </> : <>
            {resource?.service_kind !== "GENIO_BOT" ? <Button onClick={() => setEditingConnection(backend)} variant="outline">
              <PencilIcon data-icon="inline-start" />
              {t("Edit Connection")}
            </Button> : null}
            {!configurationRequired && backend.verification_state !== "VERIFIED" ? (
              <Button
                disabled={actionBusy}
                onClick={() => void runAction(() => verifyResourceConnection(tenantId, backend.resource_id, backend.connection_id))}
                variant="outline"
              >
                <CheckCircle2Icon data-icon="inline-start" />
                {t("Verify and enable")}
              </Button>
            ) : null}
            {backend.verification_state === "VERIFIED" && backend.lifecycle === "DISABLED" ? (
              <Button disabled={actionBusy} variant="outline" onClick={() => void runAction(() => runLifecycle("ENABLE"))}>{t("Enable")}</Button>
            ) : null}
            {backend.lifecycle === "ENABLED" ? (
              <Button disabled={actionBusy} variant="outline" onClick={() => void runAction(() => runLifecycle("DISABLE"))}>{t("Disable")}</Button>
            ) : null}
            {!resource?.installation_owned ? <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" aria-label={t("More actions")}>
                  <MoreHorizontalIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuGroup>
                  {backend.lifecycle !== "REVOKED" && backend.lifecycle !== "REVOKE_PENDING" ? (
                    <DropdownMenuItem onSelect={() => void runAction(() => runLifecycle("REQUEST_REVOKE"))}>{t("Revoke")}</DropdownMenuItem>
                  ) : null}
                  {backend.lifecycle === "REVOKE_PENDING" ? (
                    <DropdownMenuItem disabled={!canConfirmRevoke} onSelect={() => void runAction(() => runLifecycle("CONFIRM_REVOKED"))}>
                      {t(canConfirmRevoke ? "Finalize revoke" : "Awaiting Runtime ACK")}
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={!canDelete || backend.lifecycle === "REVOKED" || backend.lifecycle === "REVOKE_PENDING"}
                    onSelect={() => setDeletingConnection(backend)}
                  >
                    <Trash2Icon />
                    {t("Delete Connection")}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu> : null}
          </>}
          backLabel={t("Back to Connections")}
          onBack={() => setSelectedConnectionId(null)}
          title={<span className="flex flex-wrap items-center gap-2">{backend.display_name}<Badge variant="outline">{backend.kind}</Badge><Badge variant={backend.lifecycle === "ENABLED" ? "secondary" : "outline"}>{t(backend.lifecycle)}</Badge></span>}
        />
        {actionError ? <div role="alert" className="text-sm text-destructive">{t(actionError)}</div> : null}
        {actionFeedback ? <div role="status" className="text-sm text-emerald-700 dark:text-emerald-400">{actionFeedback}</div> : null}
        <Card data-testid="connection-status-summary">
          <CardHeader className="gap-1 border-b">
            <CardTitle>{t("Connection status")}</CardTitle>
            <p className="text-sm text-muted-foreground">{t("Saved configuration, verification, and Runtime application are reported separately.")}</p>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <div>
              <div className="text-xs text-muted-foreground">{t("Saved configuration")}</div>
              <div className="mt-1 font-medium">{t("Revision")} {backend.configuration_revision}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">{t("Verification")}</div>
              <div className="mt-1"><Badge variant={backend.verification_state === "VERIFIED" ? "secondary" : backend.verification_state === "FAILED" ? "destructive" : "outline"}>{t(backend.verification_state)}</Badge></div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">{t("Connection state")}</div>
              <div className="mt-1"><Badge variant={backend.lifecycle === "ENABLED" ? "secondary" : "outline"}>{t(backend.lifecycle)}</Badge></div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">{t("Gateway release report")}</div>
              <div className="mt-1 font-medium">{selectedReleaseRevision === null ? t("No synchronized release report") : t("Gateway reports revision {{revision}}", { revision: selectedReleaseRevision })}</div>
              <p className="mt-1 text-xs text-muted-foreground">{t("The Gateway report does not confirm this saved configuration is serving traffic.")}</p>
            </div>
          </CardContent>
        </Card>
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(18rem,0.75fr)]">
          <Card>
            <CardHeader className="gap-1 border-b">
              <CardTitle>{t("Configuration")}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
              {[
                [t("Resource"), resource?.display_name ?? backend.resource_id],
                [t("Endpoint"), endpoint],
                [t("Observed health"), t(backend.health_state)],
                [t("Priority"), String(backend.routing_priority)],
                [t("Region"), backend.region ?? t("Not assigned")],
                [t("TLS certificate"), t(backend.certificate?.status ?? "NOT_CONFIGURED")],
                [personalCredentialMode ? t("Personal account") : t("Credential profile"), personalCredentialMode
                  ? t("Site settings belong to this Connection. Personal credentials are connected separately by each user.")
                  : backend.provider_credential_profile
                    ? `${credentialProfiles.find((profile) => profile.profile_id === backend.provider_credential_profile?.profile_id)?.display_name ?? t("Unresolved reference")} · ${t("Revision")} ${backend.provider_credential_profile.revision}`
                    : backend.credential_configured
                      ? t("Credential reference bound")
                      : t("Not bound")],
              ].map(([label, value]) => (
                <div key={label}>
                  <div className="text-xs text-muted-foreground">{label}</div>
                  <div className={`mt-1 break-all font-medium ${label === t("Endpoint") ? "font-mono text-xs" : ""}`}>{value}</div>
                </div>
              ))}
            </CardContent>
          </Card>
          <div className="flex flex-col gap-4">
            {resource?.builtin_service ? <Card><CardContent className="py-5 text-sm text-muted-foreground">{t("Installed and managed by GenioOne. Discovery uses your signed-in identity and only returns your visible Catalog.")}</CardContent></Card> : resource?.service_kind === "GENIO_BOT" ? <Card><CardContent className="py-5 text-sm text-muted-foreground">{t("Genio Bot is installed with this deployment. Its personal Codex access is controlled by One Policy.")}</CardContent></Card> : resource?.installation_owned && !backend.connector_configuration ? <Card><CardContent className="py-5 text-sm text-muted-foreground">{t("Installed connector transport is ready. Configure the site settings before connecting personal accounts or enabling traffic.")}</CardContent></Card> : <ConnectionTestPanel key={backend.connection_id} tenantId={tenantId} connection={backend} />}
          {!resource?.builtin_service ? <Card>
            <CardHeader className="gap-1 border-b"><CardTitle>{t("Runtime controls")}</CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-3">
              {backend.kind === "MCP" ? (
                <McpMetadataSheet
                  tenantId={tenantId}
                  backend={backend}
                  editable={backend.lifecycle !== "REVOKED" && backend.lifecycle !== "REVOKE_PENDING" && (!resource || !hasPendingPublication(resource))}
                  onUpdated={onRefresh}
                />
              ) : null}
              {backend.kind === "MCP" ? (
                <McpRoutingSheet tenantId={tenantId} backend={backend} onUpdated={onRefresh} />
              ) : null}
              {backend.kind === "API" && canDelete && resource ? (
                <ApiRequestMappingSheet
                  tenantId={tenantId}
                  resource={resource}
                  connection={backend}
                  onUpdated={onRefresh}
                />
              ) : null}
              <ConnectionCertificateSheet
                connection={backend}
                editable={backend.lifecycle !== "REVOKED" && backend.lifecycle !== "REVOKE_PENDING"}
                onUpdated={onRefresh}
                tenantId={tenantId}
              />
              {onOpenResource ? (
                <Button onClick={() => onOpenResource(backend.resource_id)} type="button" variant="outline">{t("Open Resource")}</Button>
              ) : null}
            </CardContent>
          </Card> : null}
          </div>
        </div>
        <EditConnectionSheet
          tenantId={tenantId}
          connection={editingConnection}
          serviceKind={editingConnection ? resourcesById.get(editingConnection.resource_id)?.service_kind : null}
          ownerOrganizationId={editingConnection ? resourcesById.get(editingConnection.resource_id)?.owner_organization_id ?? null : null}
          open={editingConnection !== null}
          onOpenChange={(open) => { if (!open) setEditingConnection(null) }}
          onUpdated={async () => {
            await onRefresh()
            setActionFeedback(t("Connection saved. Check verification and release status before using the updated configuration."))
          }}
        />
        <AlertDialog
          open={deletingConnection !== null}
          onOpenChange={(open) => { if (!open) setDeletingConnection(null) }}
        >
          <AlertDialogContent data-testid="connection-delete-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle>{t("Delete Connection")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("Delete {{name}}? This removes the upstream from this draft Resource.", {
                  name: deletingConnection?.display_name ?? "",
                })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={deleteConnection}>{t("Delete Connection")}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    )
  }

  if (creating) {
    return (
      <CreateConnectionWizard
        tenantId={tenantId}
        resources={resources.filter((resource) => !resource.builtin_service && !resource.installation_owned)}
        defaultResourceId={focusedResourceId ?? undefined}
        onCancel={() => setCreating(false)}
        onCreated={async (connectionId) => {
          await onRefresh()
          setCreating(false)
          setSelectedConnectionId(connectionId)
        }}
      />
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        actions={<Button disabled={Boolean(focusedResource?.builtin_service || focusedResource?.installation_owned) || !resources.some((resource) => !resource.builtin_service && !resource.installation_owned && ["MCP", "LLM", "API"].includes(resource.kind))} onClick={() => setCreating(true)}>
          <PlusIcon data-icon="inline-start" />
          {t("Add Connection")}
        </Button>}
        backLabel={focusedResourceId ? t("Back to Resource") : undefined}
        description={<span data-testid="connection-upstream-help">{t("Manage the model, MCP, and API upstream connections used by your Resources.")}</span>}
        onBack={focusedResourceId ? () => onOpenResource?.(focusedResourceId) : undefined}
        title={focusedResource ? t("{{name}} Connections", { name: focusedResource.display_name }) : t("Connections")}
      />
      {!resources.some((resource) => !resource.builtin_service && !resource.installation_owned && ["MCP", "LLM", "API"].includes(resource.kind)) ? <p className="text-sm text-muted-foreground">{t("Create an MCP, LLM, or API Resource before adding a Connection.")} <a className="underline" href="?view=resources">{t("Resources")}</a></p> : null}
      {focusedResource ? <ResourceContextTabs active="connections" onOverview={() => onOpenResource?.(focusedResource.resource_id)} /> : null}
      <Card>
        <CardHeader className="gap-4 border-b">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>
              <TitleHelp help={t("Connection configuration is staged separately from Catalog publication and only affects traffic after a successor runtime release is applied.")}>{t("Managed Connections")}</TitleHelp>
            </CardTitle>
            <Badge variant="outline">{t("{{count}} Connections", { count: connectionRows.length })}</Badge>
          </div>
        </CardHeader>
        <CardContent className="px-0">
          <DataTable
            stateKey={`${tenantId}:connections:${focusedResourceId ?? "all"}`}
            columns={connectionColumns}
            data={connectionRows}
            initialFilterValues={{ visibility: "ACTIVE" }}
            filters={[{
              allLabel: t("All visibility"),
              columnId: "visibility",
              label: t("Visibility"),
              options: [
                { label: t("In use"), value: "ACTIVE" },
                { label: t("Archived"), value: "ARCHIVED" },
              ],
            }, {
              allLabel: t("All connection types"),
              columnId: "kind",
              label: t("Type"),
              options: [
                { label: "LLM", value: "LLM" },
                { label: "MCP", value: "MCP" },
                { label: "API", value: "API" },
              ],
            }, {
              allLabel: t("All connection states"),
              columnId: "lifecycle",
              label: t("State"),
              options: [
                { label: t("ENABLED"), value: "ENABLED" },
                { label: t("DISABLED"), value: "DISABLED" },
                { label: t("DRAFT"), value: "DRAFT" },
                { label: t("REVOKE_PENDING"), value: "REVOKE_PENDING" },
                { label: t("REVOKED"), value: "REVOKED" },
              ],
            }]}
            getRowId={(row) => row.connection.connection_id}
            getRowLabel={(row) => row.connection.display_name}
            getRowTestId={(row) => `connection-row-${row.connection.connection_id}`}
            noResults={<DataEmpty icon={GaugeIcon} title={t(connectionRows.length ? "No matching Connections" : "No Connections")} description={t(connectionRows.length ? "Try another type or search term." : "Add a Connection to a Resource to configure and verify its upstream service.")} />}
            onRowClick={(row) => setSelectedConnectionId(row.connection.connection_id)}
            pageSize={10}
            searchPlaceholder={t("Search Connections")}
          />
        </CardContent>
      </Card>
      <EditConnectionSheet
        tenantId={tenantId}
        connection={editingConnection}
        serviceKind={editingConnection ? resourcesById.get(editingConnection.resource_id)?.service_kind : null}
        ownerOrganizationId={editingConnection ? resourcesById.get(editingConnection.resource_id)?.owner_organization_id ?? null : null}
        open={editingConnection !== null}
        onOpenChange={(open) => { if (!open) setEditingConnection(null) }}
        onUpdated={async () => {
          await onRefresh()
          setActionFeedback(t("Connection saved. Check verification and release status before using the updated configuration."))
        }}
      />
      <AlertDialog
        open={deletingConnection !== null}
        onOpenChange={(open) => { if (!open) setDeletingConnection(null) }}
      >
        <AlertDialogContent data-testid="connection-delete-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Delete Connection")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("Delete {{name}}? This removes the upstream from this draft Resource.", {
                name: deletingConnection?.display_name ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={deleteConnection}>{t("Delete Connection")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
