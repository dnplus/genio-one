import { useEffect, useRef, type RefObject } from "react"
import {
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
  type NodeTypes,
  type ReactFlowInstance,
} from "@xyflow/react"

import { cn } from "@/lib/utils"

import "@xyflow/react/dist/style.css"

export type TopologyOrientation = "horizontal" | "vertical"

function preserveNodePointerEvents() {
  // React Flow disables pointer events on non-selectable, non-draggable nodes
  // unless a node interaction handler is present. Descendant controls still
  // own the actual interaction.
}

export function TopologyFlowCanvas<TNode extends Node, TEdge extends Edge>({
  ariaLabel,
  className,
  containerRef,
  edges,
  nodeTypes,
  nodes,
  orientation,
  testId,
}: {
  ariaLabel: string
  className?: string
  containerRef?: RefObject<HTMLDivElement | null>
  edges: TEdge[]
  nodeTypes: NodeTypes
  nodes: TNode[]
  orientation: TopologyOrientation
  testId: string
}) {
  const flowRef = useRef<ReactFlowInstance<TNode, TEdge> | null>(null)

  useEffect(() => {
    if (!nodes.length) return
    const frame = window.requestAnimationFrame(() => {
      void flowRef.current?.fitView({ padding: 0.14, maxZoom: 1 })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [edges, nodes, orientation])

  useEffect(() => {
    const container = containerRef?.current
    if (!container) return
    let frame = 0
    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        void flowRef.current?.fitView({ padding: 0.14, maxZoom: 1 })
      })
    })
    observer.observe(container)
    return () => {
      observer.disconnect()
      window.cancelAnimationFrame(frame)
    }
  }, [containerRef])

  return <div
    ref={containerRef}
    className={cn("h-[32rem] min-h-0 w-full min-w-0 overflow-hidden rounded-lg border bg-muted/10", className)}
    role="group"
    aria-label={ariaLabel}
    data-testid={testId}
  >
    <ReactFlow<TNode, TEdge>
      key={orientation}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      nodesFocusable={false}
      onNodeClick={preserveNodePointerEvents}
      edgesFocusable={false}
      elementsSelectable={false}
      edgesReconnectable={false}
      connectOnClick={false}
      deleteKeyCode={null}
      panOnDrag
      panOnScroll
      zoomOnScroll={false}
      zoomOnPinch
      zoomOnDoubleClick={false}
      preventScrolling
      minZoom={0.3}
      maxZoom={1.5}
      fitView
      fitViewOptions={{ padding: 0.14, maxZoom: 1 }}
      onInit={(instance) => {
        flowRef.current = instance
      }}
      proOptions={{ hideAttribution: true }}
    >
      <Background color="var(--border)" gap={18} size={1} />
      <Controls showInteractive={false} position="bottom-right" />
    </ReactFlow>
  </div>
}
