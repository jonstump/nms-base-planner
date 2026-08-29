import { ReactFlow, type Edge, type Node } from "@xyflow/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import "@xyflow/react/dist/base.css";

import { formatQuantity, type ResolvedGraph } from "../boundary";
import { StatusBadge } from "../shell/StatusBadge";
import { toCanvasModel, toLayoutInput } from "./graph-model";
import { layoutGraph, NODE_HEIGHT, NODE_WIDTH, type Placement } from "./layout";
import { NodeCard } from "./NodeCard";
import { TreeEdge } from "./TreeEdge";

/*
 * The dependency tree.
 *
 * Governing: ADR-0004 (React view layer), SPEC-0006 REQ "Graph Rendering
 * From the Boundary Payload", REQ "Layout Geometry Is Not a Domain Value",
 * REQ "Edge Rendering", Accessibility Requirements
 *
 * One payload in, positioned nodes and drawn edges out. There is no second
 * boundary call anywhere in this file and no read of the Tier 1 artifact —
 * the whole tree comes from the `graph` prop, which is one `resolve`
 * result.
 *
 * The node array is built by iterating the payload's order and is never
 * sorted. That order is the domain's, it is the tab order the design asked
 * for, and SPEC-0006's own reasoning is that re-deriving it here would be a
 * second place for it to drift. There is no comparator in this file.
 *
 * `nodesFocusable` and `nodesConnectable` are off. The first because React
 * Flow's node wrapper would take a tab stop and the card inside it takes
 * another, which would make every node cost two — the accessibility
 * requirement is one tab stop per node. The second because this story
 * renders; it does not let anyone rewire a crafting tree by dragging.
 *
 * Only React Flow's `base.css` is imported, not its full theme. base.css is
 * the positioning and transform rules the renderer cannot work without;
 * the theme carries colour literals, and every colour on this surface
 * resolves through a token in canvas.css instead.
 */

const NODE_TYPES = { card: NodeCard };
const EDGE_TYPES = { tree: TreeEdge };

export function TreeCanvas({ graph }: { readonly graph: ResolvedGraph }): ReactNode {
  const model = useMemo(() => toCanvasModel(graph), [graph]);
  const [placements, setPlacements] = useState<ReadonlyMap<string, Placement> | null>(
    null,
  );

  useEffect(() => {
    let live = true;
    const { nodes, edges } = toLayoutInput(model);
    void layoutGraph(nodes, edges).then((laid) => {
      if (live) setPlacements(laid);
    });
    return () => {
      live = false;
    };
  }, [model]);

  const flowNodes = useMemo<Node[]>(
    () =>
      model.nodes.map((node) => ({
        id: node.id,
        type: "card",
        position: placements?.get(node.id) ?? { x: 0, y: 0 },
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        draggable: false,
        selectable: false,
        data: {
          node,
          /*
           * Grouped for display and not otherwise touched. `formatQuantity`
           * inserts separators into the string the module sent; it does not
           * parse it, and SPEC-0005 forbids the view doing arithmetic on a
           * quantity anywhere, including here.
           */
          display: formatQuantity(node.total, { groupSeparator: "," }),
        },
      })),
    [model, placements],
  );

  const flowEdges = useMemo<Edge[]>(
    () =>
      model.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: "tree",
        data: {
          perUnit: edge.perUnit,
          targetMethod: edge.targetMethod,
        },
      })),
    [model],
  );

  if (!placements) {
    /*
     * Pending, never zero, and never a graph drawn at the origin. Every
     * node placed at (0, 0) would render as one pile that resolves into a
     * tree a frame later, which reads as a rendering fault.
     */
    return <StatusBadge status="pending" detail="laying out the tree" />;
  }

  return (
    <section className="tree-canvas" aria-label="Dependency tree">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        nodesFocusable={false}
        nodesConnectable={false}
        nodesDraggable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        panOnDrag
        zoomOnScroll={false}
        fitView
        proOptions={{ hideAttribution: false }}
      />
    </section>
  );
}
