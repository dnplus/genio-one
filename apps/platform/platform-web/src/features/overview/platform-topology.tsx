import { memo, useEffect, useRef, useState, type ReactNode } from "react"
import { Handle, MarkerType, Position, type Edge, type Node, type NodeProps } from "@xyflow/react"
import {
  ArrowUpRightIcon,
  BoxesIcon,
  GripVerticalIcon,
  LaptopIcon,
  NetworkIcon,
  ServerIcon,
  ShieldCheckIcon,
  UsersRoundIcon,
  type LucideIcon,
} from "lucide-react"
import { useTranslation } from "react-i18next"

import type { PageId } from "@/components/app-sidebar"
import { TopologyFlowCanvas, type TopologyOrientation } from "@/components/topology-flow-canvas"
import { layoutTopologyNodes } from "@/components/topology-layout"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { ConnectionSummary, OverviewSnapshot, ResourceKind, ResourceRegistration } from "@/domain/contracts"
import { buildOverviewNodes, runtimeFilterForProductLane, type BreakdownItem, type OverviewNode } from "@/features/overview/overview-model"
import { cn } from "@/lib/utils"

type BoundaryId = "AI_MCP_GATEWAY" | "API_MANAGEMENT" | "SECURE_ACCESS"
type BoundaryMode = "REVERSE_PROXY" | "SECURE_ACCESS"
export type AccessTier = "T1" | "T2"

interface BoundaryDefinition {
  id: BoundaryId
  label: string
  mode: BoundaryMode
  moduleLabel: string
  moduleFilter: string
  resourceKinds: ResourceKind[]
  callerLabel: string
  targetLabel: string
}

const boundaries: BoundaryDefinition[] = [
  { id: "AI_MCP_GATEWAY", label: "AI Gateway", mode: "REVERSE_PROXY", moduleLabel: "AI Gateway", moduleFilter: "AI_MCP_GATEWAY", resourceKinds: ["LLM", "MCP"], callerLabel: "Identities", targetLabel: "Connections" },
  { id: "API_MANAGEMENT", label: "API Gateway", mode: "REVERSE_PROXY", moduleLabel: "API Gateway", moduleFilter: "API_MANAGEMENT", resourceKinds: ["API"], callerLabel: "Applications", targetLabel: "Connections" },
  { id: "SECURE_ACCESS", label: "Secure Access", mode: "SECURE_ACCESS", moduleLabel: "Access Gateway", moduleFilter: "SECURE_ACCESS", resourceKinds: [], callerLabel: "Identities", targetLabel: "Private targets" },
]

const nodeIcons: Record<OverviewNode["id"], LucideIcon> = { clients: UsersRoundIcon, endpoints: LaptopIcon, gateway: NetworkIcon, resources: BoxesIcon }

type ScopedTopology = { resources: ResourceRegistration[]; connections: ConnectionSummary[] }

function statusVariant(status?: BreakdownItem["status"]) {
  if (status === "warning") return "destructive" as const
  if (status === "healthy") return "secondary" as const
  return "outline" as const
}

function itemTestId(nodeId: string, label: string) {
  return `overview-topology-${nodeId}-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
}

function BreakdownButton({ node, item, onOpenList }: { node: OverviewNode; item: BreakdownItem; onOpenList: (page: PageId, filter?: string) => void }) {
  const { t } = useTranslation()
  const value = typeof item.value === "number" ? item.value : t(item.value)
  const translatedLabel = t(item.label)
  return <Button aria-label={`${translatedLabel} · ${value}`} className="w-full rounded-full" data-testid={itemTestId(node.id, item.label)} data-ui onClick={() => onOpenList(item.target ?? node.target, item.filter)} size="xs" variant={statusVariant(item.status)}>
    {translatedLabel}<span className="tabular-nums">{value}</span>
  </Button>
}

function NodeCard({ id, label, value, icon: Icon, target, onOpenList, children, accent = false }: {
  id: string
  label: string
  value: number | string
  icon: LucideIcon
  target?: { page: PageId; filter?: string }
  onOpenList: (page: PageId, filter?: string) => void
  children?: ReactNode
  accent?: boolean
}) {
  return <Card className={cn("nodrag nopan w-full items-stretch gap-2 bg-card py-3 text-center shadow-sm", accent && "ring-primary/40")} data-testid={`overview-topology-${id}`}>
    <CardHeader className="items-center gap-2 px-4 pb-0">
      <Badge className="w-fit" data-ui variant="outline"><GripVerticalIcon data-icon="inline-start" />{label}</Badge>
      <div className="flex min-w-0 items-center gap-2">
        <Button aria-label={`${label} · ${value}`} className="relative h-auto min-h-10 min-w-0 flex-1 justify-center px-8 text-center" data-ui onClick={() => target && onOpenList(target.page, target.filter)} size="sm" variant="ghost">
          <Icon data-icon="inline-start" /><span className="text-2xl font-semibold tabular-nums">{value}</span>{target ? <ArrowUpRightIcon className="absolute right-2" data-icon="inline-end" /> : null}
        </Button>
      </div>
    </CardHeader>
    {children ? <CardContent className="flex flex-wrap justify-center gap-1.5 px-4 pt-1">{children}</CardContent> : null}
  </Card>
}

function GatewayTrafficRow({ boundary, data, onOpenList }: { boundary: BoundaryDefinition; data: OverviewSnapshot; onOpenList: (page: PageId, filter?: string) => void }) {
  const { t } = useTranslation()
  const summary = data.gatewayMetrics
  const metrics = [
    { label: "Gateway requests", value: summary?.request_count.toLocaleString() ?? "—" },
    { label: "Errors", value: summary?.error_count.toLocaleString() ?? "—" },
    { label: "Average latency", value: summary?.average_latency_millis === null || summary?.average_latency_millis === undefined ? "—" : `${summary.average_latency_millis.toFixed(1)} ms` },
  ]
  return <Button
    className="relative grid h-auto w-full gap-2 px-3 py-2 pr-9 text-center"
    data-ui
    aria-label={t("Gateway traffic")}
    onClick={() => onOpenList("activity", boundary.id)}
    size="sm"
    style={{ gridTemplateColumns: `repeat(${metrics.length}, minmax(0, 1fr))` }}
    variant="outline"
  >
    {metrics.map((metric) => <span className="flex min-w-0 flex-col items-center gap-0.5" key={metric.label}><span className="whitespace-nowrap text-[10px] text-muted-foreground">{t(metric.label)}</span><span className="font-semibold tabular-nums">{metric.value}</span></span>)}
    <ArrowUpRightIcon className="absolute right-3 shrink-0" data-icon="inline-end" />
  </Button>
}

function scopedTopology(data: OverviewSnapshot, boundary: BoundaryDefinition): ScopedTopology {
  const resources = data.resources.filter((resource) => boundary.resourceKinds.includes(resource.kind))
  if (boundary.mode === "SECURE_ACCESS") return { resources, connections: [] }
  const resourceIds = new Set(resources.map((resource) => resource.resource_id))
  return { resources, connections: data.connections.filter((connection) => resourceIds.has(connection.resource_id)) }
}

type PlatformNodeContent = {
  accent?: boolean
  children?: ReactNode
  icon: LucideIcon
  id: string
  label: string
  onOpenList: (page: PageId, filter?: string) => void
  target?: { page: PageId; filter?: string }
  value: number | string
}
type PlatformFlowNodeData = Record<string, unknown> & PlatformNodeContent & {
  hasIncoming: boolean
  hasOutgoing: boolean
  orientation: TopologyOrientation
}
type PlatformFlowNode = Node<PlatformFlowNodeData, "platform-topology-node">
type PlatformFlowEdge = Edge<Record<string, never>, "straight">

function PlatformTopologyNode({ data }: NodeProps<PlatformFlowNode>) {
  const horizontal = data.orientation === "horizontal"
  return <>
    {data.hasIncoming ? <Handle type="target" position={horizontal ? Position.Left : Position.Top} isConnectable={false} className="!size-2 !border-background !bg-primary" /> : null}
    <NodeCard {...data} />
    {data.hasOutgoing ? <Handle type="source" position={horizontal ? Position.Right : Position.Bottom} isConnectable={false} className="!size-2 !border-background !bg-primary" /> : null}
  </>
}

const platformNodeTypes = { "platform-topology-node": memo(PlatformTopologyNode) }

function BoundaryCanvas({ data, boundary, nodes, onOpenList, accessTier }: { data: OverviewSnapshot; boundary: BoundaryDefinition; nodes: OverviewNode[]; onOpenList: (page: PageId, filter?: string) => void; accessTier: AccessTier }) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const [orientation, setOrientation] = useState<TopologyOrientation>("horizontal")
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver(([entry]) => setOrientation(entry.contentRect.width < 820 ? "vertical" : "horizontal"))
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  const scoped = scopedTopology(data, boundary)
  const identityNode = nodes.find((node) => node.id === "clients")!
  const endpointNode = nodes.find((node) => node.id === "endpoints")!
  const gatewayNode = nodes.find((node) => node.id === "gateway")!
  const moduleStatus = gatewayNode.breakdown.find((item) => item.filter === boundary.moduleFilter)
  const endpointReady = Number(endpointNode.breakdown.find((item) => item.label === "Ready")?.value ?? 0)
  const endpointOffline = Number(endpointNode.breakdown.find((item) => item.label === "Offline")?.value ?? 0)
  const isSecureAccess = boundary.mode === "SECURE_ACCESS"
  const showEndpoint = isSecureAccess && accessTier === "T2"
  const moduleLabel = isSecureAccess ? accessTier === "T2" ? "Secure Access Gateway" : "Access Gateway" : boundary.moduleLabel
  const callerValue = boundary.id === "API_MANAGEMENT" ? data.applications.length : identityNode.value
  const targetValue = isSecureAccess ? data.applications.length : scoped.connections.length
  const activeBindings = scoped.connections.filter((connection) => connection.lifecycle === "ENABLED").length
  const identityItems = boundary.id === "API_MANAGEMENT" ? identityNode.breakdown.filter((item) => item.label === "Applications") : identityNode.breakdown.filter((item) => ["Person", "Applications", "Agents", "Observed clients"].includes(item.label))

  type Definition = { id: string; width: number; height: number; data: PlatformNodeContent }
  const definitions: Definition[] = [{
    id: "caller", width: 280, height: 190,
    data: {
      id: `${boundary.id}-caller`, icon: boundary.id === "API_MANAGEMENT" ? nodeIcons.resources : nodeIcons.clients, label: t(boundary.callerLabel), onOpenList, target: { page: boundary.id === "API_MANAGEMENT" ? "applications" : "people" }, value: callerValue,
      children: <div className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] gap-1.5 [&>*:last-child]:col-span-3">{identityItems.map((item) => <BreakdownButton item={item} key={item.label} node={identityNode} onOpenList={onOpenList} />)}</div>,
    },
  }]

  if (showEndpoint) definitions.push({
    id: "endpoint", width: 240, height: 210,
    data: {
      id: `${boundary.id}-endpoint`, icon: nodeIcons.endpoints, label: t("Endpoint"), onOpenList, target: { page: "runtimes", filter: "ENDPOINT" }, value: endpointNode.value,
      children: <><Progress aria-label={t("Ready ratio")} className="w-full" value={endpointNode.progress} /><Badge variant="secondary">{t("Secure Access")}</Badge><Button data-ui onClick={() => onOpenList("runtimes", "ENDPOINT READY")} size="xs" variant="secondary">{t("Ready")} <span className="tabular-nums">{endpointReady}</span></Button><Button data-ui onClick={() => onOpenList("runtimes", "ENDPOINT OFFLINE")} size="xs" variant="outline">{t("Offline")} <span className="tabular-nums">{endpointOffline}</span></Button></>,
    },
  })

  definitions.push({
    id: "gateway", width: 340, height: 205,
    data: {
      accent: true, id: `${boundary.id}-gateway`, icon: NetworkIcon, label: t(moduleLabel), onOpenList, target: { page: "runtimes", filter: moduleStatus?.value === "Ready" || moduleStatus?.value === "Degraded" ? runtimeFilterForProductLane(boundary.moduleFilter) : "GATEWAY" }, value: moduleStatus?.value === "Not reported" || moduleStatus?.value === "Awaiting report" ? t(moduleStatus.value) : gatewayNode.value,
      children: <>{boundary.id === "AI_MCP_GATEWAY" ? <GatewayTrafficRow boundary={boundary} data={data} onOpenList={onOpenList} /> : null}{isSecureAccess ? <><Button data-ui onClick={() => onOpenList("resources", "SAAS")} size="xs" variant="secondary">{t("Sites")} <span className="tabular-nums">{data.resources.filter((resource) => resource.kind === "SAAS").length}</span></Button><Button data-ui onClick={() => onOpenList("resources", "PRIVATE_APPLICATION")} size="xs" variant="secondary">{t("Private applications")} <span className="tabular-nums">{data.applications.length}</span></Button></> : boundary.resourceKinds.map((kind) => <Button data-ui key={kind} onClick={() => onOpenList("resources", kind)} size="xs" variant="secondary">{kind} <span className="tabular-nums">{scoped.resources.filter((resource) => resource.kind === kind).length}</span></Button>)}</>,
    },
  }, {
    id: "target", width: 280, height: 150,
    data: {
      id: `${boundary.id}-target`, icon: isSecureAccess ? ShieldCheckIcon : ServerIcon, label: t(boundary.targetLabel), onOpenList, target: isSecureAccess ? undefined : { page: "connections" }, value: targetValue,
      children: isSecureAccess ? <Badge variant="outline">{t("Applications")} <span className="tabular-nums">{data.applications.length}</span></Badge> : <><Badge variant="secondary">{t("Active")} <span className="tabular-nums">{activeBindings}</span></Badge>{scoped.connections.length > activeBindings ? <Badge variant="outline">{t("Disabled")} <span className="tabular-nums">{scoped.connections.length - activeBindings}</span></Badge> : null}</>,
    },
  })

  const initialFlowNodes = definitions.map((definition, index): PlatformFlowNode => ({
    id: definition.id,
    type: "platform-topology-node",
    data: { ...definition.data, hasIncoming: index > 0, hasOutgoing: index < definitions.length - 1, orientation },
    position: { x: 0, y: 0 },
    width: definition.width,
    height: definition.height,
    initialWidth: definition.width,
    initialHeight: definition.height,
    draggable: false,
  }))
  const flowEdges = definitions.slice(1).map((definition, index): PlatformFlowEdge => ({
    id: `${definitions[index].id}->${definition.id}`,
    source: definitions[index].id,
    target: definition.id,
    type: "straight",
    style: { stroke: "var(--primary)", strokeWidth: 1.75 },
    markerEnd: { type: MarkerType.ArrowClosed, color: "var(--primary)", width: 18, height: 18 },
  }))
  const flowNodes = layoutTopologyNodes({
    edges: flowEdges,
    nodes: initialFlowNodes,
    orientation,
    rankGap: 80,
  })

  return <TopologyFlowCanvas<PlatformFlowNode, PlatformFlowEdge>
    ariaLabel={t(boundary.label)}
    className={orientation === "horizontal" ? "h-[21rem]" : "h-[32rem]"}
    containerRef={containerRef}
    edges={flowEdges}
    nodeTypes={platformNodeTypes}
    nodes={flowNodes}
    orientation={orientation}
    testId={`overview-topology-canvas-${boundary.id.toLowerCase()}`}
  />
}

export function PlatformTopology({ accessTier, data, onOpenList }: { accessTier: AccessTier; data: OverviewSnapshot; onOpenList: (page: PageId, filter?: string) => void }) {
  const { t } = useTranslation()
  const nodes = buildOverviewNodes(data)
  return <Card data-testid="overview-platform-topology">
    <CardHeader className="gap-2"><div className="text-lg font-medium">{t("Platform topology")}</div></CardHeader>
    <CardContent className="pt-0">
      <Tabs defaultValue={boundaries[0].id}>
        <TabsList className="h-auto max-w-full justify-start overflow-x-auto">
          {boundaries.map((boundary) => <TabsTrigger className="flex-none sm:min-w-32" data-testid={`overview-topology-tab-${boundary.id.toLowerCase()}`} key={boundary.id} value={boundary.id}>{t(boundary.id === "SECURE_ACCESS" ? accessTier === "T2" ? "Secure Access Gateway" : "Access Gateway" : boundary.label)}</TabsTrigger>)}
        </TabsList>
        {boundaries.map((boundary) => <TabsContent className="mt-4" key={boundary.id} value={boundary.id}><BoundaryCanvas accessTier={accessTier} boundary={boundary} data={data} nodes={nodes} onOpenList={onOpenList} /></TabsContent>)}
      </Tabs>
    </CardContent>
  </Card>
}
