import { Graph, layout } from "@dagrejs/dagre"
import type { Edge, Node } from "@xyflow/react"

import type { TopologyOrientation } from "@/components/topology-flow-canvas"

export function layoutTopologyNodes<TNode extends Node, TEdge extends Edge>({
  edges,
  nodeGap = 32,
  nodes,
  orientation,
  rankGap = 72,
}: {
  edges: TEdge[]
  nodeGap?: number
  nodes: TNode[]
  orientation: TopologyOrientation
  rankGap?: number
}): TNode[] {
  const graph = new Graph().setDefaultEdgeLabel(() => ({}))
  graph.setGraph({
    rankdir: orientation === "horizontal" ? "LR" : "TB",
    ranksep: rankGap,
    nodesep: nodeGap,
    marginx: 0,
    marginy: 0,
  })

  for (const node of nodes) {
    graph.setNode(node.id, {
      width: node.width ?? node.initialWidth ?? node.measured?.width ?? 0,
      height: node.height ?? node.initialHeight ?? node.measured?.height ?? 0,
    })
  }
  for (const edge of edges) graph.setEdge(edge.source, edge.target)

  layout(graph)

  return nodes.map((node) => {
    const position = graph.node(node.id)
    const width = node.width ?? node.initialWidth ?? node.measured?.width ?? 0
    const height = node.height ?? node.initialHeight ?? node.measured?.height ?? 0
    return {
      ...node,
      position: {
        x: position.x - width / 2,
        y: position.y - height / 2,
      },
    }
  })
}
