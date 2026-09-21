import { RelationValue } from "@/components/relation-value"
import { useRecordSelection } from "@/hooks/use-record-selection"
import { isDecisionAuditEvent } from "@/domain/audit-events"
import { createColumnHelper } from "@tanstack/react-table"
import { DatabaseIcon, FilePenLineIcon, GitForkIcon, GlobeIcon, LockKeyholeIcon, PencilIcon, PlusIcon, SendIcon } from "lucide-react"
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import { DataEmpty } from "@/components/data-empty"
import { DataTable, TableView } from "@/components/data-table/data-table"
import type { DataTableFeatures } from "@/components/data-table/data-table-features"
import { PageHeader } from "@/components/page-header"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { SearchableSelect } from "@/components/ui/searchable-select"
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import type { IdentitySession, OverviewSnapshot, ResourcePublicationEndpoint, ResourceRegistration } from "@/domain/contracts"
import { organizationAdministratorSubjectIds } from "@/domain/organization-roles"
import { createActivityDisplayDirectory } from "@/features/activity/activity-display"
import { CreateResourceWizard } from "@/features/resources/create-resource-wizard"
import { ResourceContextTabs } from "@/features/resources/resource-context-tabs"
import {
  enforcementLabel,
  gatewayGroupMatchesResource,
  governanceStatus,
  hasPendingPublication,
  publicationEndpointReady,
  publicationErrorDetails,
  publicationState,
  requiresPublicationEndpoint,
  resourceAccessSummary,
  resourceAdministration,
  resourceAdministrationState,
  resourceFamily,
  resourceFamilyLabel,
  resourceInventoryVisibility,
  resourceSubtype,
  type PublicationListState,
  type ResourceFamily,
} from "@/features/resources/resource-administration"
import {
  inboundAuthenticationOptionLabel,
} from "@/features/resources/resource-control-options"
import { ResourceEnforcementChainCard } from "@/features/resources/resource-enforcement-chain-card"
import { ResourceModelRoutingCard } from "@/features/resources/resource-model-routing-card"
import { ResourcePublicModelsCard } from "@/features/resources/resource-public-models-card"
import {
  bumpResourceVersion,
  nextVersionInLineage,
  publicationBasePathForVersion,
  versionLineage,
  type VersioningPathStrategy,
} from "@/features/resources/resource-versioning"
import { isMockMode } from "@/lib/runtime-mode"
import { formatEpochSeconds } from "@/lib/personal-preferences"
import { ProductApiError, createResource, setResourceLifecycle, setResourcePublicationEndpoint, transitionResourceConnectionLifecycle, updateResource, verifyResourcePublicationDns } from "@/lib/product-api"

type ResourceRow = {
  capabilityCount: number
  connectionCount: number
  enforcement: string
  entitlementCount: number
  environment: string
  family: ResourceFamily
  governance: string
  identityCount: number
  ownerOrganization: string
  publication: PublicationListState
  resource: ResourceRegistration
  subtype: string
  visibility: "ACTIVE" | "EXITING" | "ARCHIVED"
}

type RecentActivityRow = {
  id: string
  occurredAt: number
  result: string
  subjectId: string
}

type ApiRequestMappingRow = {
  action: "PASSTHROUGH" | "SET" | "REMOVE"
  connection: string
  id: string
  location: "HEADER" | "QUERY"
  name: string
  operation: string
  value: string | null
}

type DraftDefinition = Pick<ResourceRegistration, "display_name" | "version">
type ResourceDocumentation = { readme: string }
type ResourceEditMode = "definition" | "documentation"
type InboundAuthentication = "PLATFORM_OAUTH" | "EXTERNAL_OAUTH" | "API_KEY" | "MTLS" | "GATEWAY_NATIVE"
type AuthorizationAuthority = "ONE_POLICY" | "GATEWAY_NATIVE" | "UPSTREAM"
type WorkflowMode = "STANDARD" | "CUSTOM"
type ResourceControlProfile = {
  authorizationAuthority: AuthorizationAuthority
  endpointEnforcement: boolean
  identityMapping: string
  inboundAuthentication: InboundAuthentication
  oauthAudience: string
  oauthIssuer: string
  oauthJwksUrl: string
  oauthScope: string
  requestSchemaValidation: boolean
  workflowMode: WorkflowMode
  workflowReference: string
}

const resourceColumnHelper = createColumnHelper<DataTableFeatures, ResourceRow>()
const capabilityColumnHelper = createColumnHelper<DataTableFeatures, ResourceRegistration["capabilities"][number]>()
const activityColumnHelper = createColumnHelper<DataTableFeatures, RecentActivityRow>()
const apiRequestMappingColumnHelper = createColumnHelper<DataTableFeatures, ApiRequestMappingRow>()

function subjectLabel(data: OverviewSnapshot, subjectId: string) {
  return createActivityDisplayDirectory(data).subject(subjectId).label
}

function publicationLabel(resource: ResourceRegistration, t: (key: string) => string) {
  if (resource.service_kind === "GENIO_BOT") return t("Installed service / Not Published")
  if (resource.publication_request?.publication_state === "FAILED") return t("Publication failed")
  if (hasPendingPublication(resource)) return t("Pending approval")
  if (resource.lifecycle === "PUBLISHED") return t("Published")
  if (resource.lifecycle === "DEPRECATED") return t("Deprecated")
  if (resource.lifecycle === "RETIRED") return t("Retired")
  if (resource.kind === "SAAS") return t("Tracked / Not Published")
  return t("Draft / Owner Organization Testing")
}

function publicationHint(resource: ResourceRegistration, t: (key: string) => string) {
  if (resource.service_kind === "GENIO_BOT") return t("Installed Genio Bot is governed by One Policy and is not published through a Gateway.")
  if (resource.publication_request?.publication_state === "FAILED") {
    return t(resource.publication_request.failure_code ?? "Publication failed")
  }
  if (hasPendingPublication(resource)) return t("Publication is awaiting Tenant Administrator approval. The Resource remains Draft and hidden from the Catalog.")
  if (resource.lifecycle === "PUBLISHED") return t("Published resource is discoverable.")
  if (resource.lifecycle === "DEPRECATED") return t("Deprecated resource remains available while consumers migrate.")
  if (resource.lifecycle === "RETIRED") return t("Retired resource is no longer discoverable.")
  return t("Draft is hidden from the Catalog. Verified Owner Organization members can access it for testing and validation.")
}

function accessScopeLabel(resource: ResourceRegistration, t: (key: string) => string) {
  if (resource.builtin_service) return t("Signed-in account")
  if (resource.service_kind === "GENIO_BOT") return t("One Policy")
  if (resource.lifecycle === "DRAFT") return t("Owner Organization testing")
  if (resource.lifecycle === "RETIRED") return t("Unavailable")
  return t("One Policy")
}

function publicationStatusLabel(state: PublicationListState, t: (key: string) => string, resource?: ResourceRegistration) {
  if (resource?.service_kind === "GENIO_BOT") return t("Installed service / Not Published")
  if (state === "FAILED") return t("Publication failed")
  if (state === "PENDING_APPROVAL") return t("Pending approval")
  if (state === "PUBLISHED") return t("Published")
  if (state === "DEPRECATED") return t("Deprecated")
  if (state === "RETIRED") return t("Retired")
  return t("Draft")
}

function publicationBadgeVariant(state: PublicationListState) {
  if (state === "FAILED") return "destructive" as const
  if (state === "PUBLISHED") return "default" as const
  if (state === "PENDING_APPROVAL") return "secondary" as const
  if (state === "DEPRECATED") return "secondary" as const
  if (state === "RETIRED") return "secondary" as const
  return "outline" as const
}

function resourceControlProfile(resource: ResourceRegistration): ResourceControlProfile {
  const inboundSecurity = resource.api?.inbound_security
  const inboundAuthentication: InboundAuthentication = inboundSecurity?.type === "API_KEY"
    ? "API_KEY"
    : inboundSecurity?.type === "MTLS" || inboundSecurity?.type === "MTLS_AND_JWT"
      ? "MTLS"
      : inboundSecurity?.type === "KEYLESS"
        ? "GATEWAY_NATIVE"
        : inboundSecurity && "issuer" in inboundSecurity && inboundSecurity.issuer
          ? "EXTERNAL_OAUTH"
          : resource.authentication_strategy === "API_KEY"
            ? "API_KEY"
            : resource.authentication_strategy === "MTLS"
              ? "MTLS"
              : resource.authentication_strategy === "NONE"
                ? "GATEWAY_NATIVE"
                : "PLATFORM_OAUTH"
  const oauthSecurity = inboundSecurity && "issuer" in inboundSecurity ? inboundSecurity : null

  return {
    authorizationAuthority: "ONE_POLICY",
    endpointEnforcement: resource.kind === "EXTENSION" || (resource.kind === "SAAS" && resource.service_kind !== "GENIO_BOT"),
    identityMapping: "",
    inboundAuthentication,
    oauthAudience: oauthSecurity?.audience ?? "",
    oauthIssuer: oauthSecurity?.issuer ?? "",
    oauthJwksUrl: oauthSecurity?.jwks_url ?? "",
    oauthScope: inboundSecurity?.type === "OAUTH2" ? inboundSecurity.scope : "",
    requestSchemaValidation: resource.api?.request_schema_validation ?? false,
    workflowMode: "STANDARD",
    workflowReference: "",
  }
}



function authorizationAuthorityLabel(value: AuthorizationAuthority) {
  if (value === "ONE_POLICY") return "One Policy"
  if (value === "GATEWAY_NATIVE") return "Gateway native policy"
  return "Upstream authorization"
}

function ResourceEditSheet({
  documentation,
  mode,
  onOpenChange,
  onSave,
  resource,
}: {
  documentation: ResourceDocumentation
  mode: ResourceEditMode | null
  onOpenChange: (open: boolean) => void
  onSave: (value: DraftDefinition | ResourceDocumentation) => Promise<void>
  resource: ResourceRegistration
}) {
  const { t } = useTranslation()
  const [displayName, setDisplayName] = useState(resource.display_name)
  const [readme, setReadme] = useState(documentation.readme)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const isDefinition = mode === "definition"

  return (
    <Sheet open={mode !== null} onOpenChange={onOpenChange}>
      <SheetContent presentation="side" side="right">
        <SheetHeader>
          <SheetTitle>{t(isDefinition ? "Edit draft" : "Edit README")}</SheetTitle>
        </SheetHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={async (event) => {
            event.preventDefault()
            setSaving(true)
            setError("")
            try { await onSave(isDefinition ? { display_name: displayName.trim(), version: resource.version } : { readme: readme.trim() }) }
            catch (caught) { setError(caught instanceof Error ? caught.message : "RESOURCE_UPDATE_FAILED") }
            finally { setSaving(false) }
          }}
        >
          <FieldGroup className="px-4 py-2">
            {isDefinition ? <>
              <Field>
                <FieldLabel htmlFor="resource-display-name">{t("Display name")}</FieldLabel>
                <Input id="resource-display-name" onChange={(event) => setDisplayName(event.target.value)} required value={displayName} />
              </Field>
              <Field>
                <FieldLabel>{t("Version")}</FieldLabel>
                <Input readOnly value={resource.version} />
                <FieldDescription>{t("Version is assigned when this configuration changes. Fork a published Resource to keep the previous version available.")}</FieldDescription>
              </Field>
            </> : <Field>
              <FieldLabel htmlFor="resource-readme">{t("README")}</FieldLabel>
              <Textarea id="resource-readme" onChange={(event) => setReadme(event.target.value)} value={readme} />
            </Field>}
          </FieldGroup>
          {error ? <div role="alert" className="px-4 text-sm text-destructive">{t(error)}</div> : null}
          <SheetFooter>
            <Button disabled={saving} type="submit">{t(saving ? "Saving" : "Save")}</Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}

function PublicationEndpointSheet({
  endpoint,
  gatewayGroups,
  onOpenChange,
  onSave,
  open,
  resource,
}: {
  endpoint?: ResourcePublicationEndpoint | null
  gatewayGroups: Array<{ value: string; label: string; description?: string }>
  onOpenChange: (open: boolean) => void
  onSave: (endpoint: ResourcePublicationEndpoint) => Promise<void>
  open: boolean
  resource: ResourceRegistration
}) {
  const { t } = useTranslation()
  const fixedBasePath = resource.kind === "LLM" ? "/" : null
  const [hostname, setHostname] = useState(endpoint?.hostname ?? "")
  const [gatewayId, setGatewayId] = useState(endpoint?.gateway_id ?? gatewayGroups[0]?.value ?? "")
  const [versioningPath, setVersioningPath] = useState<VersioningPathStrategy>("REPLACE")
  const [basePath, setBasePath] = useState(fixedBasePath ?? endpoint?.base_path ?? resource.api?.public_path ?? "/")
  const [visibility, setVisibility] = useState<ResourcePublicationEndpoint["visibility"]>(endpoint?.visibility ?? "PRIVATE")
  const [dnsManagement, setDnsManagement] = useState<ResourcePublicationEndpoint["dns_management"]>(endpoint?.dns_management ?? "EXTERNAL")
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState("")
  const resolvedBasePath = fixedBasePath ?? publicationBasePathForVersion(resource, versioningPath, basePath)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent presentation="side" side="right">
        <SheetHeader>
          <SheetTitle>{t("Configure publication endpoint")}</SheetTitle>
        </SheetHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={async (event) => {
            event.preventDefault()
            setSaving(true)
            setSaveError("")
            const nextHostname = hostname.trim().toLowerCase()
            const nextBasePath = resolvedBasePath
            const addressChanged = nextHostname !== endpoint?.hostname || nextBasePath !== endpoint?.base_path || dnsManagement !== endpoint?.dns_management || gatewayId !== endpoint?.gateway_id
            try {
              await onSave({
                gateway_id: gatewayId,
                hostname: nextHostname,
                base_path: nextBasePath,
                visibility,
                dns_management: dnsManagement,
                dns_verification: addressChanged ? "PENDING" : endpoint?.dns_verification ?? "PENDING",
                dns_target: null,
              })
              onOpenChange(false)
            } catch (caught) {
              setSaveError(caught instanceof Error ? caught.message : "Save failed")
            } finally {
              setSaving(false)
            }
          }}
        >
          <FieldGroup className="px-4 py-2">
            <Field>
              <FieldLabel>{t("Gateway")}</FieldLabel>
              <SearchableSelect value={gatewayId} options={gatewayGroups} onValueChange={setGatewayId} placeholder={t("Select Gateway group")} searchPlaceholder={t("Search Gateway groups")} emptyLabel={t("No Gateway groups found.")} />
              <FieldDescription>{t("The Resource type determines the projected route; this selects the installed Gateway group that receives it.")}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="publication-hostname">{t("Public hostname")}</FieldLabel>
              <Input id="publication-hostname" maxLength={253} pattern="[a-z0-9]([a-z0-9\-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9\-]*[a-z0-9])?)*" title={t("Enter a hostname without a protocol, port, path, or spaces.")} onChange={(event) => setHostname(event.target.value)} placeholder={t("Public hostname example")} required value={hostname} />
              <FieldDescription>{t("Enter a hostname without a protocol, port, path, or spaces.")}</FieldDescription>
            </Field>
            {fixedBasePath === null ? (
              <Field>
                <FieldLabel>{t("Versioning path")}</FieldLabel>
                <Select value={versioningPath} onValueChange={(value) => setVersioningPath(value as VersioningPathStrategy)}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectGroup>
                    <SelectItem value="REPLACE">{t("Replace current path")}</SelectItem>
                    <SelectItem value="COEXIST">{t("Publish alongside previous versions")}</SelectItem>
                  </SelectGroup></SelectContent>
                </Select>
                <FieldDescription>{t("Choose how this version is exposed. Previous versions stay published until you deprecate them.")}</FieldDescription>
              </Field>
            ) : null}
            <Field>
              <FieldLabel htmlFor="publication-base-path">{t("Base path")}</FieldLabel>
              <Input disabled={fixedBasePath !== null || versioningPath === "COEXIST"} id="publication-base-path" onChange={(event) => setBasePath(event.target.value)} pattern="/.*" placeholder={t("Base path example")} required value={resolvedBasePath} />
              <FieldDescription>{t(fixedBasePath === null ? (versioningPath === "COEXIST" ? "This version is published under a versioned path so earlier versions can keep their routes." : "The path must begin with a slash.") : "AI model publications use the Envoy AI Gateway root path (/).")}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel>{t("Catalog visibility")}</FieldLabel>
              <Select value={visibility} onValueChange={(value) => setVisibility(value as ResourcePublicationEndpoint["visibility"])}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectGroup>
                  <SelectItem value="PRIVATE">{t("PRIVATE")}</SelectItem>
                  <SelectItem value="REQUEST">{t("REQUEST")}</SelectItem>
                  <SelectItem value="PUBLIC">{t("PUBLIC")}</SelectItem>
                </SelectGroup></SelectContent>
              </Select>
              <FieldDescription>{t("Private Resources remain owner-only; Request Resources appear in the Catalog for approval; Public Resources can be activated directly.")}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel>{t("DNS management")}</FieldLabel>
              <Select value={dnsManagement} onValueChange={(value) => setDnsManagement(value as ResourcePublicationEndpoint["dns_management"])}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectGroup>
                  <SelectItem value="PLATFORM_MANAGED">{t("Platform managed")}</SelectItem>
                  <SelectItem value="EXTERNAL">{t("External DNS")}</SelectItem>
                </SelectGroup></SelectContent>
              </Select>
              <FieldDescription>{t(dnsManagement === "EXTERNAL" ? "Point this hostname to the Gateway DNS target, then verify it before publication." : "The platform provisions DNS routing for this hostname.")}</FieldDescription>
            </Field>
          </FieldGroup>
          <SheetFooter>
            {saveError ? <FieldError role="alert">{t(saveError)}</FieldError> : null}
            <Button disabled={saving} type="submit">{t(saving ? "Saving…" : "Save endpoint")}</Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}

function ResourceDetail({
  data,
  documentation,
  controls,
  identity,
  isTenantAdministrator,
  tenantId,
  resource,
  lineageResources,
  ownerOrganization,
  onBack,
  onPublish,
  publishing,
  onReviewPublication,
  onSetLifecycle,
  onOpenConnections,
  onSaveDefinition,
  onSaveDocumentation,
  onSavePublicationEndpoint,
  onVerifyPublicationDns,
  onFork,
  onSelectResource,
}: {
  data: OverviewSnapshot
  documentation: ResourceDocumentation
  controls: ResourceControlProfile
  identity: IdentitySession
  isTenantAdministrator: boolean
  tenantId: string
  resource: ResourceRegistration
  lineageResources: ResourceRegistration[]
  ownerOrganization?: OverviewSnapshot["organizations"][number]
  onBack: () => void
  onPublish: (resource: ResourceRegistration) => Promise<void>
  publishing: boolean
  onReviewPublication: (resource: ResourceRegistration, decision: "APPROVE" | "REJECT") => Promise<void>
  onSetLifecycle: (lifecycle: "DEPRECATED" | "RETIRED") => Promise<void>
  onOpenConnections?: (resourceId: string, options?: { create?: boolean }) => void
  onSaveDefinition: (definition: DraftDefinition) => Promise<void>
  onSaveDocumentation: (documentation: ResourceDocumentation) => Promise<void>
  onSavePublicationEndpoint: (endpoint: ResourcePublicationEndpoint) => Promise<void>
  onVerifyPublicationDns: () => Promise<void>
  onFork: (resource: ResourceRegistration) => Promise<void>
  onSelectResource: (resourceId: string) => void
}) {
  const { t } = useTranslation()
  const [editMode, setEditMode] = useState<ResourceEditMode | null>(null)
  const [publicationEditing, setPublicationEditing] = useState(false)
  const [publicModelRevision, setPublicModelRevision] = useState(0)
  const connections = data.connections.filter((connection) => connection.resource_id === resource.resource_id)
  const activity = data.auditEvents.filter(isDecisionAuditEvent).filter((event) => event.resource_id === resource.resource_id)
  const access = resourceAccessSummary(data, resource.resource_id)
  const {
    canManageDraft,
    canManageResource,
    isPublished,
    pendingPublication,
    publicationBlocker,
  } = resourceAdministrationState({ data, identity, isTenantAdministrator, resource })
  const isInstalledGenioBot = resource.service_kind === "GENIO_BOT"
  const recentActivity: RecentActivityRow[] = [
    ...activity.map((event) => ({
      id: event.audit_event_id,
      subjectId: event.subject.subject_id,
      result: event.outcome,
      occurredAt: event.occurred_at,
    })),
    ...data.activity.recent_activity.filter((event) => event.resource_id === resource.resource_id).map((event) => ({
      id: event.activity_id,
      subjectId: event.subject_id,
      result: event.route,
      occurredAt: event.observed_at,
    })),
    ...data.apiActivity.events.filter((event) => event.resource_id === resource.resource_id).map((event) => ({
      id: event.correlation_id,
      subjectId: event.subject_id ?? t("Unknown"),
      result: event.outcome,
      occurredAt: event.occurred_at,
    })),
  ].sort((left, right) => right.occurredAt - left.occurredAt)
  const capabilityColumns = useMemo(() => capabilityColumnHelper.columns([
    capabilityColumnHelper.accessor("display_name", { header: t("Display name") }),
    capabilityColumnHelper.display({
      id: "source",
      header: t("Source"),
      cell: () => t("Resource definition"),
      enableSorting: false,
    }),
  ]), [t])
  const apiRequestMappingRows = useMemo<ApiRequestMappingRow[]>(() => {
    const operations = new Map(resource.capabilities.map((capability) => [
      capability.capability_id,
      capability.display_name,
    ]))
    for (const operation of resource.api?.operations ?? []) operations.set(
      operation.operation_id,
      `${operation.method} ${operation.path}`,
    )
    return connections.flatMap((connection) => connection.request_mapping?.rules.map((rule, index) => ({
      action: rule.action,
      connection: connection.display_name,
      id: `${connection.connection_id}:${index}`,
      location: rule.location,
      name: rule.name,
      operation: rule.operation_id ? operations.get(rule.operation_id) ?? rule.operation_id : t("All operations"),
      value: rule.value,
    })) ?? [])
  }, [connections, resource.api?.operations, resource.capabilities, t])
  const lineage = versionLineage(lineageResources, resource)
  const apiRequestMappingColumns = useMemo(() => apiRequestMappingColumnHelper.columns([
    apiRequestMappingColumnHelper.accessor("connection", { header: t("Connection") }),
    apiRequestMappingColumnHelper.accessor("operation", { header: t("Operation") }),
    apiRequestMappingColumnHelper.accessor("location", {
      header: t("Location"),
      cell: ({ getValue }) => t(getValue() === "HEADER" ? "Header" : "Query parameter"),
    }),
    apiRequestMappingColumnHelper.accessor("name", { header: t("Upstream parameter") }),
    apiRequestMappingColumnHelper.accessor("action", {
      header: t("Action"),
      cell: ({ row }) => (
        <div>
          <Badge variant="outline">{t(row.original.action === "SET" ? "Override" : row.original.action === "REMOVE" ? "Remove" : "Pass through")}</Badge>
          {row.original.action === "SET" ? <div className="mt-1 font-mono text-xs text-muted-foreground">{row.original.value}</div> : null}
        </div>
      ),
    }),
  ]), [t])
  const activityColumns = useMemo(() => activityColumnHelper.columns([
    activityColumnHelper.accessor("subjectId", {
      header: t("Identity"),
      cell: ({ getValue }) => subjectLabel(data, getValue()),
    }),
    activityColumnHelper.accessor("result", {
      header: t("Result"),
      cell: ({ getValue }) => <Badge variant="outline">{t(getValue())}</Badge>,
    }),
    activityColumnHelper.accessor("occurredAt", {
      header: t("Time"),
      cell: ({ getValue }) => formatEpochSeconds(getValue()),
    }),
  ]), [data, t])

  return (
    <div className="flex flex-col gap-5" data-testid="resource-detail-page">
      <PageHeader
        actions={<>
          {pendingPublication && isTenantAdministrator ? <>
            <Button onClick={() => void onReviewPublication(resource, "REJECT")} variant="outline">
              {t("Reject")}
            </Button>
            <Button onClick={() => void onReviewPublication(resource, "APPROVE")}>
              <SendIcon data-icon="inline-start" />
              {t("Approve publication")}
            </Button>
          </> : canManageDraft && !isInstalledGenioBot ? <>
            <Button onClick={() => setEditMode("definition")} variant="outline">
              <PencilIcon data-icon="inline-start" />
              {t("Edit draft")}
            </Button>
            <Button onClick={() => setEditMode("documentation")} variant="outline"><FilePenLineIcon />{t("Edit README")}</Button>
            <Button
              disabled={publishing || publicationBlocker === "CONNECTION_REQUIRED"}
              onClick={() => publicationEndpointReady(resource) ? void onPublish(resource) : setPublicationEditing(true)}
              title={publicationBlocker === "CONNECTION_REQUIRED" ? t("At least one enabled Connection is required before publication.") : undefined}
            >
              <SendIcon data-icon="inline-start" />
              {publishing ? t("Publishing…") : isTenantAdministrator ? t("Publish") : t("Submit for approval")}
            </Button>
          </> : pendingPublication ? <Badge variant="secondary">{t("Pending approval")}</Badge>
          : isPublished && canManageResource && !isInstalledGenioBot ? <>
            <Button onClick={() => setEditMode("documentation")} variant="outline">
              <FilePenLineIcon data-icon="inline-start" />
              {t("Edit README")}
            </Button>
            {resource.lifecycle === "PUBLISHED" ? (
              <Button disabled={publishing} onClick={() => void onPublish(resource)}>
                <SendIcon data-icon="inline-start" />
                {publishing ? t("Publishing…") : isTenantAdministrator ? t("Apply staged changes") : t("Submit staged changes")}
              </Button>
            ) : null}
            {resource.lifecycle === "PUBLISHED" || resource.lifecycle === "DEPRECATED" ? (
              <Button onClick={() => void onFork(resource)} variant="outline">
                <GitForkIcon data-icon="inline-start" />
                {t("Fork version")}
              </Button>
            ) : null}
            {resource.lifecycle === "PUBLISHED" ? (
              <Button onClick={() => void onSetLifecycle("DEPRECATED")} variant="outline">
                {t("Deprecate")}
              </Button>
            ) : null}
            {resource.lifecycle === "DEPRECATED" ? (
              <Button onClick={() => void onSetLifecycle("RETIRED")} variant="destructive">
                {t("Retire")}
              </Button>
            ) : null}
          </> : null}
        </>}
        backLabel={t("Back to Resources")}
        onBack={onBack}
        title={<span className="flex flex-wrap items-center gap-2">{resource.display_name}<Badge variant="outline">{t(resourceFamilyLabel(resource))}</Badge><Badge variant="secondary">{t(governanceStatus(resource))}</Badge></span>}
      />
      {resource.builtin_service ? <Alert><AlertTitle>{t("Built-in MCP")}</AlertTitle><AlertDescription>{t("Installed and managed by GenioOne. Discovery uses your signed-in identity and only returns your visible Catalog.")}</AlertDescription></Alert> : isInstalledGenioBot ? <Alert><AlertTitle>{t("Genio Bot service")}</AlertTitle><AlertDescription>{t("Genio Bot is installed with this deployment. Its personal Codex access is controlled by One Policy.")}</AlertDescription></Alert> : null}
      <ResourceContextTabs
        active="overview"
        onConnections={() => onOpenConnections?.(resource.resource_id)}
        showConnections={resource.kind !== "EXTENSION" && (resource.kind !== "SAAS" || resource.service_kind === "GENIO_BOT")}
      />

      {!resource.builtin_service && requiresPublicationEndpoint(resource) && canManageDraft ? <Alert data-testid="resource-connection-required">
        <AlertTitle>{t("Resource Connections")}</AlertTitle>
        <AlertDescription className="flex flex-col gap-3">
          <span>{t("Connections belong to this Resource. Manage its upstreams here without rebinding another Resource's Connection.")}</span>
          {connections.slice(0, 3).map((connection) => <RelationValue key={connection.connection_id} id={connection.connection_id} label={connection.display_name} href={`?view=connections&resource=${encodeURIComponent(resource.resource_id)}&connection=${encodeURIComponent(connection.connection_id)}`} />)}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => onOpenConnections?.(resource.resource_id)}>{t("Manage Connections")}</Button>
            <Button onClick={() => onOpenConnections?.(resource.resource_id, { create: true })}>{t("Add Connection")}</Button>
          </div>
        </AlertDescription>
      </Alert> : null}

      {resource.kind === "EXTENSION" ? (
        <Card data-testid="resource-bindings">
          <CardHeader><CardTitle>{t("Package bindings")}</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">{t("A Bot includes Plugins and Skills. Those packages bind MCP and LLM Resources instead of owning a Connection.")}</p>
            {resource.extension_metadata?.profile ? (
              <div className="grid gap-3 sm:grid-cols-3">
                <div><div className="text-xs text-muted-foreground">{t("Title / job")}</div><div className="mt-1 font-medium">{resource.extension_metadata.profile.title}</div></div>
                <div className="sm:col-span-2"><div className="text-xs text-muted-foreground">{t("Work description")}</div><div className="mt-1 font-medium">{resource.extension_metadata.profile.description}</div></div>
              </div>
            ) : null}
            {[["Bound Plugins", resource.extension_metadata?.plugins ?? []], ["Bound Skills", resource.extension_metadata?.skills ?? []]].map(([label, items]) => (
              <div key={label as string}>
                <div className="mb-2 text-xs text-muted-foreground">{t(label as string)}</div>
                {(items as Array<{ name?: string; id?: string; path?: string; marketplace?: string }>).length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("None")}</p>
                ) : (items as Array<{ name?: string; id?: string; path?: string; marketplace?: string }>).map((item) => (
                  <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm" key={item.name ?? item.id}>
                    <span>{item.name ?? item.id}</span>
                    <span className="truncate text-muted-foreground">{item.marketplace ?? item.path}</span>
                  </div>
                ))}
              </div>
            ))}
            <div>
              <div className="mb-2 text-xs text-muted-foreground">{t("Bound MCP and LLM Resources")}</div>
              {(resource.extension_metadata?.resource_bindings ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("No bindings yet. Create the MCP or LLM Resource first, then bind it from the package Draft.")}</p>
              ) : (resource.extension_metadata?.resource_bindings ?? []).map((binding) => {
                const bound = data.resources.find((candidate) => candidate.resource_id === binding.resource_id)
                return (
                  <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm" key={`${binding.resource_id}:${bound?.capabilities.find((capability) => capability.capability_id === binding.capability_id)?.display_name ?? binding.capability_id}`}>
                    <span>{bound?.display_name ?? binding.resource_id} · {bound?.capabilities.find((capability) => capability.capability_id === binding.capability_id)?.display_name ?? binding.capability_id}</span>
                    <Badge variant="outline">{bound?.kind ?? "MCP"}</Badge>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle>{t("Configuration")}</CardTitle>
            {isPublished || pendingPublication ? <Badge variant="secondary"><LockKeyholeIcon data-icon="inline-start" />{publicationStatusLabel(publicationState(resource), t)}</Badge> : null}
          </div>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-x-6 gap-y-4">
          {[
            [t("Publication"), publicationLabel(resource, t)],
            [t("Environment"), resource.environment_id],
            [t("Version"), resource.version],
            [t("Authentication"), resource.authentication_strategy],
            [t("Primary enforcement"), t(enforcementLabel(resource))],
            [t("Owner Organization"), ownerOrganization?.display_name ?? t("Not assigned")],
            [t("Access scope"), accessScopeLabel(resource, t)],
            [t("Discoverability"), publicationHint(resource, t)],
          ].map(([label, value]) => (
              <div key={label}>
                <div className="text-xs text-muted-foreground">{label}</div>
                <div className="mt-1 font-medium">{value}</div>
              </div>
            ))}
            {lineage.length > 1 ? (
              <div className="col-span-2">
                <div className="text-xs text-muted-foreground">{t("Versions")}</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {lineage.map((candidate) => (
                    <Button
                      key={candidate.resource_id}
                      onClick={() => onSelectResource(candidate.resource_id)}
                      size="sm"
                      type="button"
                      variant={candidate.resource_id === resource.resource_id ? "secondary" : "outline"}
                    >
                      {candidate.version}
                      <span className="text-muted-foreground"> · {t(candidate.lifecycle)}</span>
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t("Related access")}</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {[
              [t("Identities"), access.identityCount],
              [t("Active entitlements"), access.entitlementCount],
              [t("Recorded events"), recentActivity.length],
            ].map(([label, value]) => (
              <div className="rounded-lg border p-3" key={label}>
                <div className="text-2xl font-semibold tabular-nums">{value}</div>
                <div className="mt-1 text-xs text-muted-foreground">{label}</div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {!resource.builtin_service && requiresPublicationEndpoint(resource) ? <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle>{t("Publication endpoint")}</CardTitle>
            {canManageDraft ? <Button onClick={() => setPublicationEditing(true)} size="sm" variant="outline">
              <PencilIcon data-icon="inline-start" />
              {t(resource.publication_endpoint ? "Edit endpoint" : "Configure endpoint")}
            </Button> : resource.publication_endpoint ? <Badge variant="secondary"><LockKeyholeIcon data-icon="inline-start" />{pendingPublication ? t("Pending approval") : t("Published")}</Badge> : null}
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {resource.publication_endpoint ? <>
            <div><div className="text-xs text-muted-foreground">{t("Address")}</div><div className="mt-1 font-medium">https://{resource.publication_endpoint.hostname}{resource.publication_endpoint.base_path}</div></div>
            <div><div className="text-xs text-muted-foreground">{t("Gateway")}</div><div className="mt-1 font-medium">{t(enforcementLabel(resource))}</div></div>
            <div><div className="text-xs text-muted-foreground">{t("DNS management")}</div><div className="mt-1 font-medium">{t(resource.publication_endpoint.dns_management)}</div></div>
            <div><div className="text-xs text-muted-foreground">{t("DNS verification")}</div><div className="mt-1 flex items-center gap-2"><Badge variant={resource.publication_endpoint.dns_verification === "VERIFIED" ? "default" : "secondary"}>{t(resource.publication_endpoint.dns_verification)}</Badge>{canManageDraft && resource.publication_endpoint.dns_verification !== "VERIFIED" ? <Button onClick={() => void onVerifyPublicationDns()} size="sm" variant="outline">{t("Verify DNS")}</Button> : null}</div></div>
            {resource.publication_endpoint.dns_management === "EXTERNAL" ? <div className="sm:col-span-2 lg:col-span-4"><div className="text-xs text-muted-foreground">{t("Gateway DNS target")}</div><div className="mt-1 font-mono text-sm">{resource.publication_endpoint.dns_target ?? t("Configure the Gateway DNS target in deployment settings.")}</div></div> : null}
          </> : <div className="flex items-center gap-3 sm:col-span-2 lg:col-span-4"><GlobeIcon className="text-muted-foreground" /><span className="text-sm text-muted-foreground">{t("Configure a hostname and base path before publication.")}</span></div>}
        </CardContent>
      </Card> : null}

      {resource.publication_request ? (
        <Card>
          <CardHeader><CardTitle>{t("Publication review")}</CardTitle></CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              [t("State"), t(resource.publication_request.state)],
              [t("Build state"), t(resource.publication_request.publication_state ?? "IDLE")],
              [t("Requested by"), subjectLabel(data, resource.publication_request.requested_by)],
              [t("Requested"), formatEpochSeconds(resource.publication_request.requested_at)],
              [t("Reviewed by"), resource.publication_request.reviewed_by ? subjectLabel(data, resource.publication_request.reviewed_by) : "—"],
              ...(resource.publication_request.failure_code
                ? [[t("Failure"), t(resource.publication_request.failure_code)]]
                : []),
            ].map(([label, value]) => <div key={label}><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 font-medium">{value}</div></div>)}
          </CardContent>
        </Card>
      ) : null}

      {!resource.builtin_service ? <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle>{t("Controls")}</CardTitle>
            {!resource.builtin_service && ["LLM", "MCP", "API"].includes(resource.kind) ? <Button asChild size="sm" variant="outline"><a href={`?view=policy&policy=${encodeURIComponent(JSON.stringify([resource.resource_id, resource.capabilities[0]?.capability_id ?? ""]))}`}>{t("Open policy")}</a></Button> : null}
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
              [t(resource.service_kind === "GENIO_BOT" || resourceFamily(resource) === "AI" ? "One Policy login" : "Inbound authentication"), t(resource.service_kind === "GENIO_BOT" ? "One Policy" : inboundAuthenticationOptionLabel(controls.inboundAuthentication, resourceFamily(resource)))],
              [t("Authorization authority"), t(authorizationAuthorityLabel(controls.authorizationAuthority))],
              [t("Enforcement points"), resource.service_kind === "GENIO_BOT"
                ? t("Genio Bot service")
                : resource.kind === "EXTENSION"
                ? t("Endpoint / Agent Runtime")
                : controls.endpointEnforcement
                  ? t("Gateway + Endpoint")
                  : t("Gateway only")],
              ...(resource.kind === "API" ? [[t("Request schema validation"), t(controls.requestSchemaValidation ? "Enabled" : "Disabled")]] : []),
            ].map(([label, value]) => (
              <div key={label}>
                <div className="text-xs text-muted-foreground">{label}</div>
                <div className="mt-1 font-medium">{value}</div>
              </div>
            ))}
        </CardContent>
      </Card> : null}

      {!resource.builtin_service && ["LLM", "MCP", "API"].includes(resource.kind) ? <ResourceEnforcementChainCard
        canEdit={canManageResource}
        connections={connections}
        refreshKey={publicModelRevision}
        resource={resource}
        tenantId={tenantId}
      /> : null}

      {resource.kind === "LLM" ? (
        <>
          <ResourcePublicModelsCard
            canEdit={canManageDraft}
            connections={connections}
            onSaved={() => setPublicModelRevision((revision) => revision + 1)}
            resource={resource}
            tenantId={tenantId}
          />
          <ResourceModelRoutingCard
            canEdit={canManageResource}
            organizations={data.organizations}
            refreshKey={publicModelRevision}
            resource={resource}
            tenantId={tenantId}
          />
        </>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("Resource management")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            [t("Owner Organization"), ownerOrganization?.display_name ?? t("Not assigned")],
            [t("Organization Administrators"), ownerOrganization ? organizationAdministratorSubjectIds(ownerOrganization).map((subjectId) => data.identity?.subjects.find((subject) => subject.subject_id === subjectId)?.profile.display_name ?? subjectId).join(", ") || t("Not configured") : t("Not configured")],
            [t("Data scope"), t("Organization only")],
          ].map(([label, value]) => (
            <div key={label}>
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className="mt-1 font-medium">{value}</div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card id="resource-capabilities">
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle>{t("Capabilities")}</CardTitle>
            {isPublished ? <LockKeyholeIcon className="text-muted-foreground" /> : null}
          </div>
        </CardHeader>
        <CardContent className="px-0">
          <TableView columns={capabilityColumns} data={resource.capabilities} getRowId={(capability) => capability.capability_id} noResults={t("No results.")} pageSize={5} />
        </CardContent>
      </Card>

      {resource.kind === "API" ? <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle>{t("Upstream request mapping")}</CardTitle>
              <div className="mt-1 text-sm text-muted-foreground">{t("Unspecified headers and query parameters pass through. Rules can preserve, override, or remove individual values.")}</div>
            </div>
            {canManageDraft && onOpenConnections ? <Button onClick={() => onOpenConnections(resource.resource_id)} size="sm" variant="outline">{t("Edit mappings")}</Button> : <Badge variant="secondary">{t("Pass through")}</Badge>}
          </div>
        </CardHeader>
        <CardContent className="px-0">
          {apiRequestMappingRows.length ? <TableView columns={apiRequestMappingColumns} data={apiRequestMappingRows} getRowId={(row) => row.id} noResults={t("No results.")} pageSize={10} /> : <div className="px-6 pb-6 text-sm text-muted-foreground">{t("No override rules. All upstream parameters pass through.")}</div>}
        </CardContent>
      </Card> : null}

      <Card>
        <CardHeader><CardTitle>{t("README")}</CardTitle></CardHeader>
        <CardContent className="whitespace-pre-wrap text-sm text-muted-foreground">{documentation.readme || t("No documentation yet.")}</CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t("Recent activity")}</CardTitle></CardHeader>
        <CardContent className="px-0">
          <TableView columns={activityColumns} data={recentActivity} getRowId={(event) => event.id} noResults={t("No activity recorded for this Resource.")} pageSize={10} />
        </CardContent>
      </Card>
      <ResourceEditSheet
        documentation={documentation}
        key={`${resource.resource_id}:${editMode ?? "closed"}`}
        mode={editMode}
        onOpenChange={(open) => { if (!open) setEditMode(null) }}
        onSave={async (value) => {
          if (editMode === "definition") await onSaveDefinition(value as DraftDefinition)
          else await onSaveDocumentation(value as ResourceDocumentation)
          setEditMode(null)
        }}
        resource={resource}
      />
      <PublicationEndpointSheet
        endpoint={resource.publication_endpoint}
        gatewayGroups={[...new Map(data.gatewayRegistrations
          .filter((registration) =>
            registration.state === "ACTIVE" &&
            gatewayGroupMatchesResource(resource, registration.gateway_id)
          )
          .map((registration) => [registration.gateway_id, {
            value: registration.gateway_id,
            label: registration.gateway_id,
            description: `${registration.display_name} · ${registration.site_id} · ${registration.region}`,
          }])).values()]}
        key={`${resource.resource_id}:publication:${resource.publication_endpoint?.hostname ?? "new"}`}
        onOpenChange={setPublicationEditing}
        onSave={onSavePublicationEndpoint}
        open={publicationEditing}
        resource={resource}
      />
    </div>
  )
}

export function ResourceCatalogPage({
  tenantId,
  identity,
  data,
  initialResourceId,
  search,
  onRefresh,
  onOpenConnections,
}: {
  tenantId: string
  identity: IdentitySession
  data: OverviewSnapshot
  initialResourceId?: string | null
  search: string
  onRefresh: () => Promise<void>
  onOpenConnections?: (resourceId: string, options?: { create?: boolean }) => void
}) {
  const { t } = useTranslation()
  const [creating, setCreating] = useState(false)
  const [selectedResourceId, setSelectedResourceId] = useRecordSelection("resource", initialResourceId ?? null)
  const [mockResourceChanges, setMockResourceChanges] = useState<Record<string, Partial<ResourceRegistration>>>({})
  const [mockAddedResources, setMockAddedResources] = useState<ResourceRegistration[]>([])
  const [documentation, setDocumentation] = useState<Record<string, ResourceDocumentation>>({})
  const [publishingResourceId, setPublishingResourceId] = useState<string | null>(null)
  const [publicationError, setPublicationError] = useState<{
    code: string
    violations: ReadonlyArray<{ code: string; message: string; field?: string }>
  } | null>(null)
  const isTenantAdministrator = identity.role === "TENANT_ADMINISTRATOR"
    || (data.identity?.tenant_administrators.includes(identity.subject_id) ?? false)
  const query = search.trim().toLowerCase()
  const allResources = useMemo(() => {
    const extras = mockAddedResources.filter((resource) => !data.resources.some((candidate) => candidate.resource_id === resource.resource_id))
    return [...data.resources, ...extras].map((resource) => ({ ...resource, ...mockResourceChanges[resource.resource_id] }))
  }, [data.resources, mockAddedResources, mockResourceChanges])
  const resources = useMemo(() => allResources.filter((resource) =>
    [resource.display_name, resource.resource_id, resource.kind, resource.environment_id].some((value) => value.toLowerCase().includes(query)),
  ), [allResources, query])
  const resourceRows = useMemo<ResourceRow[]>(() => resources.map((resource) => {
    const access = resourceAccessSummary(data, resource.resource_id)
    return {
      capabilityCount: resource.capabilities.length,
      connectionCount: data.connections.filter((connection) => connection.resource_id === resource.resource_id).length,
      enforcement: enforcementLabel(resource),
      entitlementCount: access.entitlementCount,
      environment: resource.environment_id,
      family: resourceFamily(resource),
      governance: governanceStatus(resource),
      identityCount: access.identityCount,
      ownerOrganization: data.organizations.find((organization) => organization.organization_id === resource.owner_organization_id)?.display_name ?? t("Not assigned"),
      publication: publicationState(resource),
      resource,
      subtype: resourceSubtype(resource),
      visibility: resourceInventoryVisibility(resource),
    }
  }), [data, resources])
  const resourceColumns = useMemo(() => resourceColumnHelper.columns([
    resourceColumnHelper.accessor((row) => row.resource.display_name, {
      id: "resource",
      header: t("Resource"),
      cell: ({ getValue }) => <span className="font-medium">{getValue()}</span>,
    }),
    resourceColumnHelper.accessor("visibility", {
      header: t("Visibility"),
      cell: ({ getValue }) => t(getValue() === "ARCHIVED" ? "Archived" : getValue() === "EXITING" ? "Exiting" : "In use"),
      filterFn: "includesString",
    }),
    resourceColumnHelper.accessor("family", {
      header: t("Type"),
      cell: ({ row }) => <><div className="font-medium">{t(resourceFamilyLabel(row.original.resource))}</div><div className="text-xs text-muted-foreground">{t(row.original.subtype)}</div></>,
      filterFn: "includesString",
    }),
    resourceColumnHelper.accessor("governance", {
      header: t("Governance mode"),
      cell: ({ getValue }) => <Badge variant="secondary">{t(getValue())}</Badge>,
    }),
    resourceColumnHelper.accessor("ownerOrganization", {
      header: t("Owner Organization"),
      filterFn: "includesString",
    }),
    resourceColumnHelper.accessor("publication", {
      header: t("Publication"),
      cell: ({ getValue, row }) => <div className="flex flex-col items-start gap-1"><Badge variant={publicationBadgeVariant(getValue())}>{publicationStatusLabel(getValue(), t, row.original.resource)}</Badge>{getValue() === "DRAFT" && row.original.resource.service_kind !== "GENIO_BOT" ? <span className="text-xs text-muted-foreground">{t("Owner Organization testing")}</span> : null}</div>,
    }),
    resourceColumnHelper.accessor("capabilityCount", { header: t("Capabilities") }),
    resourceColumnHelper.accessor("identityCount", {
      header: t("Related access"),
      cell: ({ row }) => <><div className="font-medium tabular-nums">{t("{{count}} identities", { count: row.original.identityCount })}</div><div className="text-xs text-muted-foreground tabular-nums">{t("{{count}} active entitlements", { count: row.original.entitlementCount })}</div></>,
    }),
    resourceColumnHelper.accessor("enforcement", {
      header: t("Enforcement"),
      cell: ({ row }) => <><div>{t(row.original.enforcement)}</div>{row.original.connectionCount ? <div className="text-xs text-muted-foreground">{t("{{count}} Connections", { count: row.original.connectionCount })}</div> : null}</>,
    }),
  ]), [t])
  const selectedResourceWithChanges = selectedResourceId
    ? allResources.find((resource) => resource.resource_id === selectedResourceId) ?? null
    : null
  const publicationErrorAlert = publicationError ? (
    <Alert variant="destructive">
      <AlertTitle>{t(publicationError.code)}</AlertTitle>
      <AlertDescription>
        <ul className="list-disc space-y-1 pl-5">
          {publicationError.violations.map((violation) => (
            <li key={`${violation.code}:${violation.field ?? ""}`}>{t(violation.message)}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  ) : null

  async function publishResource(resource: ResourceRegistration) {
    setPublicationError(null)
    if (resource.service_kind === "GENIO_BOT") return
    const state = resourceAdministrationState({ data, identity, isTenantAdministrator, resource })
    if (!state.canRequestPublication || state.publicationBlocker) {
      const code = !state.canRequestPublication ? "PUBLICATION_NOT_AVAILABLE" : state.publicationBlocker!
      const message = !state.canRequestPublication
        ? "This Resource is not currently available for publication. Refresh it and try again."
        : state.publicationBlocker === "CONNECTION_REQUIRED"
          ? "At least one enabled Connection is required before publication."
          : "Configure and verify the publication endpoint before publishing."
      setPublicationError({ code, violations: [{ code, message }] })
      return
    }
    if (isMockMode) {
      setMockResourceChanges((current) => ({
        ...current,
        [resource.resource_id]: isTenantAdministrator
          ? { ...current[resource.resource_id], lifecycle: "PUBLISHED", publication_request: null }
          : {
              ...current[resource.resource_id],
              publication_request: {
                request_id: `publication-request-${crypto.randomUUID()}`,
                state: "PENDING",
                requested_by: identity.subject_id,
                requested_at: Math.floor(Date.now() / 1_000),
              },
            },
      }))
      return
    }
    setPublishingResourceId(resource.resource_id)
    try {
      const controls = resourceControlProfile(resource)
      const outcome = await resourceAdministration.requestPublication({
        tenantId,
        resource,
        prepareStandardWorkflow: controls.workflowMode === "STANDARD",
        autoApprove: isTenantAdministrator,
      })
      if (outcome.status === "FAILED") throw outcome.error
      await onRefresh()
    } catch (caught) {
      setPublicationError(publicationErrorDetails(caught))
      await onRefresh().catch(() => undefined)
    } finally {
      setPublishingResourceId(null)
    }
  }

  async function savePublicationEndpoint(resource: ResourceRegistration, endpoint: ResourcePublicationEndpoint) {
    setPublicationError(null)
    if (isMockMode) {
      setMockResourceChanges((current) => ({
        ...current,
        [resource.resource_id]: { ...current[resource.resource_id], publication_endpoint: endpoint },
      }))
      return
    }
    await setResourcePublicationEndpoint(tenantId, resource.resource_id, endpoint)
    await onRefresh()
  }

  async function verifyPublicationDns(resource: ResourceRegistration) {
    if (!resource.publication_endpoint) return
    setPublicationError(null)
    if (isMockMode) {
      setMockResourceChanges((current) => ({
        ...current,
        [resource.resource_id]: {
          ...current[resource.resource_id],
          publication_endpoint: { ...resource.publication_endpoint!, dns_verification: "VERIFIED" },
        },
      }))
      return
    }
    try {
      await verifyResourcePublicationDns(tenantId, resource.resource_id, resource.publication_endpoint)
      await onRefresh()
    } catch (caught) {
      const code = caught instanceof Error ? caught.message : "PUBLICATION_DNS_NOT_VERIFIED"
      setPublicationError({
        code,
        violations: caught instanceof ProductApiError && caught.violations.length
          ? caught.violations
          : [{ code, message: code }],
      })
    }
  }

  async function reviewPublication(resource: ResourceRegistration, decision: "APPROVE" | "REJECT") {
    const request = resource.publication_request
    if (!isTenantAdministrator || !request || request.state !== "PENDING") return
    if (isMockMode) {
      setMockResourceChanges((current) => ({
        ...current,
        [resource.resource_id]: {
          ...current[resource.resource_id],
          lifecycle: decision === "APPROVE" ? "PUBLISHED" : "DRAFT",
          publication_request: {
            ...request,
            state: decision === "APPROVE" ? "APPROVED" : "REJECTED",
            reviewed_by: identity.subject_id,
            reviewed_at: Math.floor(Date.now() / 1_000),
          },
        },
      }))
      return
    }
    const outcome = await resourceAdministration.reviewPublication({
      tenantId,
      resource,
      requestId: request.request_id,
      decision,
    })
    if (outcome.status === "FAILED") throw outcome.error
    await onRefresh()
  }

  async function transitionResourceLifecycle(
    resource: ResourceRegistration,
    lifecycle: "DEPRECATED" | "RETIRED",
  ) {
    setPublicationError(null)
    if (isMockMode) {
      setMockResourceChanges((current) => ({
        ...current,
        [resource.resource_id]: { ...current[resource.resource_id], lifecycle },
      }))
      return
    }
    try {
      await setResourceLifecycle(tenantId, resource.resource_id, lifecycle)
      if (lifecycle === "RETIRED") {
        const owned = data.connections.filter((connection) =>
          connection.resource_id === resource.resource_id &&
          connection.lifecycle !== "REVOKED" &&
          connection.lifecycle !== "REVOKE_PENDING",
        )
        for (const connection of owned) {
          await transitionResourceConnectionLifecycle(tenantId, {
            resourceId: resource.resource_id,
            connectionId: connection.connection_id,
            expectedRevision: connection.configuration_revision,
            command: "REQUEST_REVOKE",
          })
        }
      }
      await onRefresh()
    } catch (caught) {
      if (caught instanceof ProductApiError) {
        setPublicationError({
          code: caught.message,
          violations: caught.violations.length
            ? caught.violations
            : [{ code: caught.message, message: caught.message }],
        })
        return
      }
      throw caught
    }
  }

  async function forkResource(resource: ResourceRegistration) {
    const version = nextVersionInLineage(allResources, resource)
    const capability = resource.capabilities[0]
    if (isMockMode) {
      const forked: ResourceRegistration = {
        ...resource,
        resource_id: `resource-fork-${crypto.randomUUID()}`,
        version,
        lifecycle: "DRAFT",
        publication_endpoint: null,
        publication_request: null,
        created_at: Math.floor(Date.now() / 1_000),
      }
      setMockAddedResources((current) => [...current, forked])
      setSelectedResourceId(forked.resource_id)
      return
    }
    const created = await createResource(tenantId, {
      displayName: resource.display_name,
      kind: resource.kind,
      capabilityId: capability?.capability_id ?? "capability",
      capabilityName: capability?.display_name ?? resource.display_name,
      environmentId: resource.environment_id,
      version,
      authenticationStrategy: resource.authentication_strategy,
      enforcementPointId: resource.enforcement_point_id,
      ownerOrganizationId: resource.owner_organization_id,
      capabilities: resource.capabilities,
      api: resource.api ?? undefined,
      extensionMetadata: resource.extension_metadata ?? undefined,
    })
    await onRefresh()
    setSelectedResourceId(created.resource_id)
  }

  if (selectedResourceWithChanges) {
    const resourceDocumentation = documentation[selectedResourceWithChanges.resource_id] ?? { readme: selectedResourceWithChanges.documentation ?? "" }
    const controls = resourceControlProfile(selectedResourceWithChanges)
    return <>
      {publicationErrorAlert}
      <ResourceDetail
      controls={controls}
      data={data}
      documentation={resourceDocumentation}
      identity={identity}
      isTenantAdministrator={isTenantAdministrator}
      tenantId={tenantId}
      onBack={() => {
        setPublicationError(null)
        setSelectedResourceId(null)
      }}
      onOpenConnections={onOpenConnections}
      onPublish={publishResource}
      publishing={publishingResourceId === selectedResourceWithChanges.resource_id}
      onReviewPublication={reviewPublication}
      onSetLifecycle={(lifecycle) => transitionResourceLifecycle(selectedResourceWithChanges, lifecycle)}
      lineageResources={allResources}
      onFork={forkResource}
      onSelectResource={setSelectedResourceId}
      onSaveDefinition={async (definition) => {
        const changed = definition.display_name !== selectedResourceWithChanges.display_name
        const version = selectedResourceWithChanges.lifecycle === "DRAFT" && changed
          ? bumpResourceVersion(selectedResourceWithChanges.version)
          : selectedResourceWithChanges.version
        const next = { ...definition, version }
        if (!isMockMode) {
          await updateResource(tenantId, selectedResourceWithChanges.resource_id, next)
          await onRefresh()
        } else setMockResourceChanges((current) => ({ ...current, [selectedResourceWithChanges.resource_id]: { ...current[selectedResourceWithChanges.resource_id], ...next } }))
      }}
      onSaveDocumentation={async (nextDocumentation) => {
        if (!isMockMode) { await updateResource(tenantId, selectedResourceWithChanges.resource_id, { documentation: nextDocumentation.readme }); await onRefresh() }
        setDocumentation((current) => ({ ...current, [selectedResourceWithChanges.resource_id]: nextDocumentation }))
      }}
      onSavePublicationEndpoint={(endpoint) => savePublicationEndpoint(selectedResourceWithChanges, endpoint)}
      onVerifyPublicationDns={() => verifyPublicationDns(selectedResourceWithChanges)}
      resource={selectedResourceWithChanges}
      ownerOrganization={data.organizations.find((organization) => organization.organization_id === selectedResourceWithChanges.owner_organization_id)}
      />
    </>
  }

  if (creating) {
    return <CreateResourceWizard
      tenantId={tenantId}
      connections={data.connections}
      resources={data.resources}
      organizations={data.organizations}
      agents={data.identity?.subjects ?? []}
      onCancel={() => setCreating(false)}
      onCreated={async (resourceId) => {
        await onRefresh()
        setSelectedResourceId(resourceId)
      }}
    />
  }

  return (
    <div className="flex flex-col gap-5">
      {publicationErrorAlert}
      <PageHeader
        actions={<Button data-testid="add-resource" onClick={() => setCreating(true)}>
          <PlusIcon data-icon="inline-start" />
          {t("Add resource")}
        </Button>}
        title={t("Resources")}
      />

      <Card>
            <CardHeader className="gap-4 border-b">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <CardTitle>{t("Resource inventory")}</CardTitle>
                <Badge variant="outline">{t("{{count}} Resources", { count: resources.length })}</Badge>
              </div>
            </CardHeader>
            <CardContent className="px-0">
              <DataTable
                stateKey={`${tenantId}:resources`} columns={resourceColumns}
                data={resourceRows}
                initialFilterValues={{ visibility: "ACTIVE" }}
                filters={[{
                  allLabel: t("All visibility"),
                  columnId: "visibility",
                  label: t("Visibility"),
                  options: [
                    { label: t("In use"), value: "ACTIVE" },
                    { label: t("Exiting"), value: "EXITING" },
                    { label: t("Archived"), value: "ARCHIVED" },
                  ],
                }, {
                  allLabel: t("All resource types"),
                  columnId: "family",
                  label: t("Resource type"),
                  options: [
                    { label: t("AI"), value: "AI" },
                    { label: t("API"), value: "API" },
                    { label: t("Access resources"), value: "ACCESS" },
                    { label: t("Extension"), value: "EXTENSION" },
                  ],
                }, {
                  allLabel: t("All Owner Organizations"),
                  columnId: "ownerOrganization",
                  label: t("Owner Organization"),
                  options: [...new Set(resourceRows.map((row) => row.ownerOrganization))].map((label) => ({ label, value: label })),
                }]}
                getRowId={(row) => row.resource.resource_id}
                noResults={<DataEmpty icon={DatabaseIcon} title={t("No matching Resources")} description={t("Try another type or search term.")} />}
                onRowClick={(row) => {
                  setPublicationError(null)
                  setSelectedResourceId(row.resource.resource_id)
                }}
                pageSize={10}
                searchPlaceholder={t("Search Resources")}
              />
            </CardContent>
      </Card>
    </div>
  )
}
