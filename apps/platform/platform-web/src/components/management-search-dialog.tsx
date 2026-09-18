import type { LucideIcon } from "lucide-react"
import {
  DatabaseIcon,
  KeyRoundIcon,
  PanelsTopLeftIcon,
  ScrollTextIcon,
  SearchIcon,
  ServerIcon,
  UsersRoundIcon,
} from "lucide-react"
import { useDeferredValue, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import type { PageId } from "@/components/app-sidebar"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { OverviewSnapshot } from "@/domain/contracts"

type SearchCategory = "ALL" | "PAGES" | "RESOURCES" | "IDENTITY" | "ACCESS" | "OPERATIONS" | "RECORDS"

interface NavigationGroup {
  label: string
  items: Array<{ id: PageId; label: string; icon: LucideIcon }>
}

interface ManagementSearchDocument {
  id: string
  category: Exclude<SearchCategory, "ALL">
  title: string
  description: string
  searchText: string
  page: PageId
  filter?: string
  focusedResourceId?: string
}

interface ManagementSearchDialogProps {
  data: OverviewSnapshot | null
  navigation: NavigationGroup[]
  open: boolean
  query: string
  currentSearch: string
  onOpenChange: (open: boolean) => void
  onQueryChange: (query: string) => void
  onSearchCurrentView: (query: string) => void
  onNavigate: (page: PageId, options?: { filter?: string; focusedResourceId?: string }) => void
}

const categoryOptions: Array<{
  id: SearchCategory
  label: string
  icon: LucideIcon
}> = [
  { id: "ALL", label: "All", icon: SearchIcon },
  { id: "PAGES", label: "Pages", icon: PanelsTopLeftIcon },
  { id: "RESOURCES", label: "Resources", icon: DatabaseIcon },
  { id: "IDENTITY", label: "Identity", icon: UsersRoundIcon },
  { id: "ACCESS", label: "Access", icon: KeyRoundIcon },
  { id: "OPERATIONS", label: "Operations", icon: ServerIcon },
  { id: "RECORDS", label: "Records", icon: ScrollTextIcon },
]

const categoryIcons = Object.fromEntries(
  categoryOptions
    .filter((category) => category.id !== "ALL")
    .map((category) => [category.id, category.icon]),
) as Record<Exclude<SearchCategory, "ALL">, LucideIcon>

function searchable(...values: Array<string | null | undefined>) {
  return values.filter(Boolean).join(" ").toLocaleLowerCase()
}

export function ManagementSearchDialog({
  data,
  navigation,
  open,
  query,
  currentSearch,
  onOpenChange,
  onQueryChange,
  onSearchCurrentView,
  onNavigate,
}: ManagementSearchDialogProps) {
  const { t } = useTranslation()
  const [category, setCategory] = useState<SearchCategory>("ALL")

  useEffect(() => {
    if (open) setCategory("ALL")
  }, [open])

  const documents = useMemo<ManagementSearchDocument[]>(() => {
    const pages = navigation.flatMap((group) => group.items.map((item) => ({
      id: `page-${item.id}`,
      category: "PAGES" as const,
      title: t(item.label),
      description: t(group.label),
      searchText: searchable(t(item.label), item.label, t(group.label), group.label),
      page: item.id,
    })))
    if (!data) return pages

    const resources: ManagementSearchDocument[] = data.resources.map((resource) => ({
      id: `resource-${resource.resource_id}`,
      category: "RESOURCES",
      title: resource.display_name,
      description: `${t(resource.kind)} · ${resource.resource_id}`,
      searchText: searchable(
        resource.display_name,
        resource.resource_id,
        resource.kind,
        resource.owner_organization_id,
        resource.environment_id,
        ...resource.capabilities.flatMap((capability) => [capability.display_name, capability.capability_id]),
      ),
      page: "resources",
      filter: resource.resource_id,
    }))

    const subjects: ManagementSearchDocument[] = (data.identity?.subjects ?? []).map((subject) => ({
      id: `subject-${subject.subject_id}`,
      category: "IDENTITY",
      title: subject.profile.display_name ?? subject.subject_id,
      description: [t(subject.kind), subject.profile.email, subject.subject_id].filter(Boolean).join(" · "),
      searchText: searchable(
        subject.subject_id,
        subject.kind,
        subject.profile.display_name,
        subject.profile.email,
        subject.profile.department,
      ),
      page: subject.kind === "PERSON" ? "people" : subject.kind === "AGENT" ? "agents" : "applications",
      filter: subject.subject_id,
    }))

    const applications: ManagementSearchDocument[] = data.applications.map((application) => ({
      id: `application-${application.application_id}`,
      category: "IDENTITY",
      title: application.display_name,
      description: `${t("Application")} · ${application.application_id}`,
      searchText: searchable(
        application.display_name,
        application.application_id,
        application.subject_id,
        application.owner_organization_id,
        application.registered_by.subject_id,
      ),
      page: "applications",
      filter: application.application_id,
    }))

    const organizations: ManagementSearchDocument[] = data.organizations.map((organization) => ({
      id: `organization-${organization.organization_id}`,
      category: "IDENTITY",
      title: organization.display_name,
      description: `${t("Organization")} · ${organization.organization_id}`,
      searchText: searchable(organization.display_name, organization.organization_id, ...organization.member_subject_ids),
      page: "organization",
      filter: organization.organization_id,
    }))

    const accessGroups: ManagementSearchDocument[] = data.accessGroups.groups.map((group) => ({
      id: `access-group-${group.access_group_id}`,
      category: "ACCESS",
      title: group.display_name,
      description: group.description || group.access_group_id,
      searchText: searchable(group.display_name, group.description, group.access_group_id),
      page: "policy",
      filter: group.display_name,
    }))

    const accessRequests: ManagementSearchDocument[] = data.accessRequests.map((request) => ({
      id: `access-request-${request.access_request_id}`,
      category: "ACCESS",
      title: `${request.resource_id} / ${request.capability_id}`,
      description: `${t(request.state)} · ${request.access_request_id}`,
      searchText: searchable(
        request.access_request_id,
        request.resource_id,
        request.capability_id,
        request.requester,
        request.target_subject,
        request.approver,
        request.state,
        request.justification,
      ),
      page: "access",
      filter: request.access_request_id,
    }))

    const entitlements: ManagementSearchDocument[] = data.ownedEntitlements.map((entitlement) => ({
      id: `entitlement-${entitlement.entitlement_id}`,
      category: "ACCESS",
      title: `${entitlement.resource_id} / ${entitlement.capability_id}`,
      description: `${t(entitlement.state)} · ${entitlement.entitlement_id}`,
      searchText: searchable(
        entitlement.entitlement_id,
        entitlement.subject_id,
        entitlement.resource_id,
        entitlement.capability_id,
        entitlement.state,
      ),
      page: "access",
      filter: entitlement.entitlement_id,
    }))

    const connections: ManagementSearchDocument[] = data.connections.map((connection) => ({
      id: `connection-${connection.connection_id}`,
      category: "OPERATIONS",
      title: connection.display_name,
      description: `${t("Connection")} · ${connection.connection_id}`,
      searchText: searchable(
        connection.display_name,
        connection.connection_id,
        connection.kind,
        connection.resource_id,
        connection.endpoint_url,
        connection.lifecycle,
      ),
      page: "connections",
      focusedResourceId: connection.resource_id,
    }))

    const runtimes: ManagementSearchDocument[] = data.runtimes.map((runtime) => ({
      id: `runtime-${runtime.runtime_id}`,
      category: "OPERATIONS",
      title: data.gatewayRegistrations.find((gateway) => gateway.runtime_id === runtime.runtime_id)?.display_name ?? runtime.runtime_id,
      description: `${t(runtime.runtime_kind)} · ${t(runtime.operator_state)}`,
      searchText: searchable(runtime.runtime_id, runtime.gateway_id, runtime.runtime_kind, runtime.operator_state, runtime.observed_state?.runtime_version, ...data.gatewayRegistrations.filter((gateway) => gateway.runtime_id === runtime.runtime_id).flatMap((gateway) => [gateway.display_name, gateway.site_id, gateway.region, gateway.state])),
      page: "runtimes",
      filter: runtime.runtime_id,
    }))

    const gateways: ManagementSearchDocument[] = data.gatewayRegistrations.filter((gateway) => !data.runtimes.some((runtime) => runtime.runtime_id === gateway.runtime_id)).map((gateway) => ({
      id: `gateway-${gateway.runtime_id}`,
      category: "OPERATIONS",
      title: gateway.display_name,
      description: `${t("Gateway")} · ${gateway.runtime_id}`,
      searchText: searchable(gateway.display_name, gateway.runtime_id, gateway.site_id, gateway.region, gateway.state),
      page: "runtimes",
      filter: gateway.runtime_id,
    }))

    const endpointActivity: ManagementSearchDocument[] = data.activity.recent_activity.map((event) => ({
      id: `endpoint-activity-${event.activity_id}`,
      category: "RECORDS",
      title: event.destination_host,
      description: `${t("Endpoint activity")} · ${event.correlation_id}`,
      searchText: searchable(
        event.activity_id,
        event.correlation_id,
        event.subject_id,
        event.device_id,
        event.destination_host,
        event.resource_id,
        event.client.status === "VERIFIED" ? event.client.acting_client_id : null,
        event.route,
      ),
      page: "activity",
      filter: event.correlation_id,
    }))

    const apiActivity: ManagementSearchDocument[] = data.apiActivity.events.map((event) => ({
      id: `api-activity-${event.correlation_id}`,
      category: "RECORDS",
      title: `${event.method} ${event.path}`,
      description: `${t("API activity")} · ${event.correlation_id}`,
      searchText: searchable(
        event.correlation_id,
        event.resource_id,
        event.capability_id,
        event.application_id,
        event.subject_id,
        event.acting_client_id,
        event.method,
        event.path,
        event.outcome,
        event.error_code,
      ),
      page: "activity",
      filter: event.correlation_id,
    }))

    const auditEvents: ManagementSearchDocument[] = data.auditEvents.map((event) => ({
      id: `audit-${event.audit_event_id}`,
      category: "RECORDS",
      title: event.kind,
      description: `${t(event.outcome)} · ${event.correlation_id}`,
      searchText: searchable(
        event.audit_event_id,
        event.correlation_id,
        event.kind,
        event.outcome,
        event.subject.subject_id,
        event.actor_subject?.subject_id,
        event.acting_client.acting_client_id,
        event.resource_id,
        event.capability_id,
        event.device_id,
        event.access_request_id,
        event.entitlement_id,
      ),
      page: "audit",
      filter: event.correlation_id,
    }))

    return [
      ...pages,
      ...resources,
      ...subjects,
      ...applications,
      ...organizations,
      ...accessGroups,
      ...accessRequests,
      ...entitlements,
      ...connections,
      ...runtimes,
      ...gateways,
      ...endpointActivity,
      ...apiActivity,
      ...auditEvents,
    ]
  }, [data, navigation, t])

  const deferredQuery = useDeferredValue(query)
  const normalizedQuery = deferredQuery.trim().toLocaleLowerCase()
  const categoryCounts = useMemo(() => {
    const counts = Object.fromEntries(categoryOptions.map((option) => [option.id, 0])) as Record<SearchCategory, number>
    counts.ALL = documents.length
    for (const document of documents) counts[document.category] += 1
    return counts
  }, [documents])
  const groupedResults = useMemo(() => {
    const queryTerms = normalizedQuery.split(/\s+/).filter(Boolean)
    const matchingDocuments = documents.filter((document) => {
      if (category !== "ALL" && document.category !== category) return false
      if (queryTerms.length === 0) return category === "ALL" ? document.category === "PAGES" : true
      return queryTerms.every((term) => document.searchText.includes(term))
    })

    return categoryOptions
      .filter((option): option is typeof option & { id: Exclude<SearchCategory, "ALL"> } => option.id !== "ALL")
      .map((option) => ({
        ...option,
        documents: matchingDocuments.filter((document) => document.category === option.id).slice(0, 12),
      }))
      .filter((group) => group.documents.length > 0)
  }, [category, documents, normalizedQuery])

  function selectDocument(document: ManagementSearchDocument) {
    onOpenChange(false)
    onNavigate(document.page, {
      filter: document.filter,
      focusedResourceId: document.focusedResourceId,
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="h-[min(84vh,52rem)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 duration-0 sm:max-w-5xl data-open:animate-none data-open:zoom-in-100 data-closed:animate-none data-closed:zoom-out-100"
        data-testid="global-search-dialog"
        showCloseButton
      >
        <DialogHeader className="border-b p-5 pr-14">
          <DialogTitle>{t("Global search")}</DialogTitle>
          <DialogDescription>
            {t("Search pages, Resources, identities, Applications, Connections, Runtimes, and records.")}
          </DialogDescription>
        </DialogHeader>
        <Command className="min-h-0 rounded-none p-0" shouldFilter={false}>
          <div className="border-b p-4">
            <CommandInput
              autoFocus
              data-testid="global-search-input"
              onValueChange={onQueryChange}
              placeholder={t("Search all management objects")}
              value={query}
            />
            <div className="mt-3 overflow-x-auto pb-1">
              <ToggleGroup
                aria-label={t("Search category")}
                className="min-w-max"
                onValueChange={(value) => {
                  if (value) setCategory(value as SearchCategory)
                }}
                size="sm"
                spacing={1}
                type="single"
                value={category}
                variant="outline"
              >
                {categoryOptions.map((option) => (
                  <ToggleGroupItem key={option.id} value={option.id}>
                    <option.icon data-icon="inline-start" />
                    {t(option.label)}
                    <span className="text-xs text-muted-foreground">{categoryCounts[option.id]}</span>
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
          </div>
          <CommandList className="min-h-0 max-h-none flex-1 p-3 [mask-image:linear-gradient(to_bottom,black_calc(100%-1.75rem),transparent)]">
            {normalizedQuery && (category === "ALL" || category === "PAGES") ? (
              <CommandGroup heading={t("Current view")}>
                <CommandItem
                  data-testid="global-search-current-view"
                  onSelect={() => {
                    onSearchCurrentView(query.trim())
                    onOpenChange(false)
                  }}
                  value={`current-view-${query.trim()}`}
                >
                  <SearchIcon />
                  <span className="min-w-0 truncate">{t("Filter current view")}: {query.trim()}</span>
                </CommandItem>
              </CommandGroup>
            ) : null}
            {groupedResults.map((group) => (
              <CommandGroup heading={t(group.label)} key={group.id}>
                {group.documents.map((document) => {
                  const Icon = categoryIcons[document.category]
                  return (
                    <CommandItem
                      data-testid={`global-search-result-${document.id}`}
                      key={document.id}
                      onSelect={() => selectDocument(document)}
                      value={document.id}
                    >
                      <Icon />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{document.title}</div>
                        <div className="truncate text-xs text-muted-foreground">{document.description}</div>
                      </div>
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            ))}
            {groupedResults.length === 0 ? <CommandEmpty>{t("No matching management objects")}</CommandEmpty> : null}
          </CommandList>
          {currentSearch ? (
            <div className="border-t px-4 py-3 text-xs text-muted-foreground">
              {t("Current view filter")}: <span className="font-medium text-foreground">{currentSearch}</span>
            </div>
          ) : null}
        </Command>
      </DialogContent>
    </Dialog>
  )
}
