import type { LucideIcon } from "lucide-react"
import {
  ActivityIcon,
  AppWindowIcon,
  BotIcon,
  CableIcon,
  ChartNoAxesCombinedIcon,
  CircleDollarSignIcon,
  DatabaseIcon,
  GaugeIcon,
  KeyRoundIcon,
  PanelsTopLeftIcon,
  RadarIcon,
  ScrollTextIcon,
  ServerIcon,
  SettingsIcon,
  ShieldCheckIcon,
  UserRoundIcon,
  UsersRoundIcon,
  WorkflowIcon,
} from "lucide-react"

export type PageId =
  | "overview"
  | "resources"
  | "connections"
  | "applications"
  | "access"
  | "policy"
  | "activity"
  | "usage"
  | "audit"
  | "traces"
  | "metrics"
  | "dashboards"
  | "intelligence"
  | "runtimes"
  | "people"
  | "agents"
  | "organization"
  | "product-docs"
  | "api-docs"
  | "personal-settings"
  | "settings"

export interface ManagementNavigationItem {
  id: PageId
  label: string
  icon: LucideIcon
}

export const managementNavigation: Array<{
  label: string
  items: ManagementNavigationItem[]
}> = [
  {
    label: "Overview",
    items: [{ id: "overview", label: "Overview", icon: GaugeIcon }],
  },
  {
    label: "Access governance",
    items: [
      { id: "resources", label: "Resources", icon: DatabaseIcon },
      { id: "connections", label: "Connections", icon: CableIcon },
      { id: "policy", label: "One Policy", icon: ShieldCheckIcon },
      { id: "access", label: "Access", icon: KeyRoundIcon },
      { id: "intelligence", label: "Access reviews", icon: RadarIcon },
    ],
  },
  {
    label: "Identity management",
    items: [
      { id: "people", label: "People", icon: UserRoundIcon },
      { id: "agents", label: "Agents", icon: BotIcon },
      { id: "applications", label: "Applications", icon: AppWindowIcon },
    ],
  },
  {
    label: "Records",
    items: [
      { id: "activity", label: "Activity", icon: ActivityIcon },
      { id: "traces", label: "Traces", icon: WorkflowIcon },
      { id: "metrics", label: "Metrics", icon: ChartNoAxesCombinedIcon },
      { id: "dashboards", label: "Dashboards", icon: PanelsTopLeftIcon },
      { id: "usage", label: "Usage and cost", icon: CircleDollarSignIcon },
      { id: "audit", label: "Audit logs", icon: ScrollTextIcon },
    ],
  },
  {
    label: "Operations",
    items: [{ id: "runtimes", label: "Runtimes", icon: ServerIcon }],
  },
  {
    label: "Administration",
    items: [
      { id: "organization", label: "Organization and roles", icon: UsersRoundIcon },
      { id: "settings", label: "Settings", icon: SettingsIcon },
    ],
  },
]

export const managementPageIds = new Set<PageId>([
  "overview",
  "resources",
  "connections",
  "applications",
  "access",
  "policy",
  "activity",
  "usage",
  "audit",
  "traces",
  "metrics",
  "dashboards",
  "intelligence",
  "runtimes",
  "people",
  "agents",
  "organization",
  "product-docs",
  "api-docs",
  "personal-settings",
  "settings",
])

export const demoGuideOrder: PageId[] = [
  "overview",
  "resources",
  "connections",
  "policy",
  "access",
  "intelligence",
  "people",
  "agents",
  "applications",
  "activity",
  "traces",
  "metrics",
  "dashboards",
  "usage",
  "audit",
  "runtimes",
  "organization",
  "settings",
  "personal-settings",
  "product-docs",
  "api-docs",
]

export const demoGuideDescriptions: Record<PageId, string> = {
  overview: "See how identities, Gateways, and governed Resources connect before reviewing current attention items.",
  resources: "Start from a governed Resource, then inspect its Capabilities and upstream Connections.",
  connections: "Manage upstream LLM, MCP, and API Connections, then bind them from a Resource.",
  policy: "Build reusable Access Groups and Access Packages, then publish the effective authorization relationship.",
  access: "Review access requests and the Entitlements that currently grant effective access.",
  intelligence: "Select a Subject to expand the effective One Policy path and inspect its blast radius.",
  people: "Review canonical People synchronized from directories or maintained as local accounts.",
  agents: "Compare registered, observed, and unknown Agents using their runtime evidence.",
  applications: "Inspect registered Applications and the credentials they use to act through the Gateways.",
  activity: "Filter attributed Gateway and Endpoint activity, then open a transaction for its policy result.",
  traces: "Follow correlated requests across the control plane and Gateway execution path.",
  metrics: "Compare request, latency, error, and enforcement metrics for the selected period.",
  dashboards: "Arrange the operational views used for regular platform monitoring.",
  usage: "Review governed usage and cost signals by Resource, model, and time range.",
  audit: "Search immutable administrative and authorization evidence by actor, target, and result.",
  runtimes: "Check Gateway and Endpoint readiness, desired state, and version drift.",
  organization: "Define organization boundaries and delegate roles to the organizations that operate them.",
  settings: "Configure Tenant-wide identity, forwarding, and platform behavior.",
  "personal-settings": "Manage language, time zone, notifications, and personal API keys for this account.",
  "product-docs": "Read workflow and concept guides rendered from the shared Markdown source.",
  "api-docs": "Explore the canonical Management API contract in Swagger UI.",
}

export function managementPageLabel(page: PageId) {
  for (const group of managementNavigation) {
    const item = group.items.find((candidate) => candidate.id === page)
    if (item) return item.label
  }
  if (page === "connections") return "Connections"
  if (page === "product-docs") return "Product documentation"
  if (page === "api-docs") return "Product API reference"
  if (page === "personal-settings") return "Personal settings"
  return "Overview"
}
