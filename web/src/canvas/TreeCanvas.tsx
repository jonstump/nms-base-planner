import { ReactFlow, type Edge, type Node } from "@xyflow/react";
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";

import "@xyflow/react/dist/base.css";

import { formatQuantity, type ResolvedGraph } from "../boundary";
import { Popover } from "../a11y/Popover";
import { StatusBadge } from "../shell/StatusBadge";
import { useViewState } from "../state/useViewState";
import { toCanvasModel, toLayoutInput, type CanvasModel } from "./graph-model";
import { layoutGraph, NODE_HEIGHT, NODE_WIDTH, type Placement } from "./layout";
import { slotFor } from "./bases";
import { NodeCard } from "./NodeCard";
import { NodeControl } from "./NodeControl";
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

/*
 * Laying out, laid out, or unable to. Three states and not two: an
 * unplaced graph draws every card at the same coordinate, so "the engine
 * failed" cannot share a representation with either "not yet" or "nothing
 * to place".
 */
type LayoutState =
  | { readonly status: "laying-out" }
  | {
      readonly status: "placed";
      readonly model: CanvasModel;
      readonly placements: ReadonlyMap<string, Placement>;
    }
  | { readonly status: "unavailable"; readonly model: CanvasModel };

const LAYING_OUT: LayoutState = { status: "laying-out" };

export function TreeCanvas({
  graph,
  onSelectMethod,
  assignments,
  onAssign,
}: {
  readonly graph: ResolvedGraph;
  /**
   * A method was chosen for a node.
   *
   * The canvas does not hold the override and does not recompute. Both are
   * the shell's, which owns the crossing — SPEC-0006 requires reassignment
   * recompute "through the boundary", and a canvas that kept its own copy
   * of the plan would be the second source of truth SPEC-0005 forbids.
   */
  readonly onSelectMethod: (nodeId: string, name: string, method: string) => void;
  /** Item id to base id. The canvas renders it; it does not own it. */
  readonly assignments: Readonly<Record<string, string>>;
  readonly onAssign: (nodeId: string, name: string, baseId: string | null) => void;
}): ReactNode {
  const model = useMemo(() => toCanvasModel(graph), [graph]);
  const [layout, setLayout] = useState<LayoutState>(LAYING_OUT);

  /*
   * Which node's control is open, by item id rather than by index. A
   * recompute replaces every node object, and an index would point at a
   * different node the moment the tree changed shape.
   */
  const [openId, setOpenId] = useState<string | null>(null);
  const controlHeadingId = useId();

  const onOpen = useCallback((nodeId: string) => {
    setOpenId(nodeId);
  }, []);
  const onCloseControl = useCallback(() => {
    setOpenId(null);
  }, []);

  /*
   * The player's separator, not this file's.
   *
   * SPEC-0009 REQ "View Preferences Survive a Reload" makes the preference
   * outlive the page; honouring it is what makes that worth doing. The flat
   * figure list reads it from the same hook, and for now the two are on
   * screen together — a hardcoded separator here would show the same figure
   * grouped in one list and ungrouped in the other, at the same moment,
   * after the player asked for one of them.
   */
  const { preferences } = useViewState();

  useEffect(() => {
    let live = true;
    const { nodes, edges } = toLayoutInput(model);
    void layoutGraph(nodes, edges).then((laid) => {
      if (!live) return;
      setLayout(
        laid === null
          ? { status: "unavailable", model }
          : { status: "placed", model, placements: laid },
      );
    });
    return () => {
      live = false;
    };
  }, [model]);

  /*
   * A settled layout belongs to the model it was computed from, and is
   * disregarded for any other. Derived here rather than reset inside the
   * effect: a new payload has no placements yet, and holding the previous
   * one for a frame would place this graph's nodes at the last graph's
   * coordinates — the pile again, for every id the two do not share.
   */
  const layoutOf: LayoutState =
    layout.status === "laying-out" || layout.model === model ? layout : LAYING_OUT;

  const flowNodes = useMemo<Node[]>(
    () =>
      model.nodes.map((node) => ({
        id: node.id,
        type: "card",
        position:
          layoutOf.status === "placed"
            ? (layoutOf.placements.get(node.id) ?? { x: 0, y: 0 })
            : { x: 0, y: 0 },
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        draggable: false,
        selectable: false,
        data: {
          node,
          onOpen,
          /*
           * SPEC-0006 REQ "Node Card": an assigned leaf carries its base's
           * colour on the border, an unassigned one a dashed neutral frame
           * and a warning dot. The slot is looked up from the assignments
           * the shell holds — the card does not know what a base is.
           */
          ...(() => {
            const slot = slotFor(assignments, node.id);
            return slot === undefined ? {} : { identity: slot };
          })(),
          /*
           * Grouped for display and not otherwise touched. `formatQuantity`
           * inserts separators into the string the module sent; it does not
           * parse it, and SPEC-0005 forbids the view doing arithmetic on a
           * quantity anywhere, including here.
           */
          display: formatQuantity(node.total, {
            groupSeparator: preferences.groupSeparator,
          }),
          /*
           * SPEC-0006: a yield "other than 1" must be visible. A yield of
           * exactly 1 is the absence of the fact, not a fact worth a line
           * on every card — the domain sends reduced rationals, so the
           * comparison is against the one string that can mean it.
           */
          yieldDisplay:
            node.recipeYield === null || node.recipeYield === "1"
              ? null
              : formatQuantity(node.recipeYield, {
                  groupSeparator: preferences.groupSeparator,
                }),
          /*
           * Exact and unrounded. `formatQuantity` keeps the `a/b` form for
           * a non-integral quantity and never produces a decimal, which is
           * what SPEC-0005's display rule requires of a rational with no
           * terminating decimal — and `5/6` is one the shipped artifact
           * really produces.
           */
          applicationsDisplay:
            node.applications === null
              ? null
              : formatQuantity(node.applications, {
                  groupSeparator: preferences.groupSeparator,
                }),
        },
      })),
    [model, layoutOf, preferences.groupSeparator, onOpen, assignments],
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

  if (layoutOf.status === "laying-out") {
    /*
     * Pending, never zero, and never a graph drawn at the origin. Every
     * node placed at (0, 0) would render as one pile that resolves into a
     * tree a frame later, which reads as a rendering fault.
     */
    return <StatusBadge status="pending" detail="laying out the tree" />;
  }

  if (layoutOf.status === "unavailable") {
    /*
     * The same reasoning as the pending state, for the case where the tree
     * never arrives. The figures are still on screen and still correct —
     * this surface is the one that failed, and it says so and names what a
     * player can do about it rather than drawing the pile.
     *
     * No StatusBadge: every word in that vocabulary is a domain fact about
     * a plan ("Deficit", "Unassigned", "Unverified"), and a layout engine
     * that would not load is not a fact about the plan.
     */
    return (
      /*
       * Inside the labelled region, unlike the pending state above. Pending
       * resolves in a frame or two; this does not, and a region that
       * disappears leaves someone navigating by region with nothing where
       * the tree was — no tree and no account of why.
       */
      <section className="tree-canvas tree-canvas-empty" aria-label="Dependency tree">
        <p className="layout-unavailable" role="status">
          The tree could not be laid out. The figures above are unaffected — reload to try
          again.
        </p>
      </section>
    );
  }

  /*
   * `find`, not an index and not a sort. The no-comparator rule this file
   * is under is about ordering the nodes for render; looking one up by the
   * id a player just clicked is neither.
   */
  const openNode =
    openId === null ? null : (model.nodes.find((node) => node.id === openId) ?? null);

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

      {/*
        The shell's Popover, not a bespoke dialog. Its trap restores focus
        in the effect cleanup, so Escape, the backdrop and the close control
        all converge on one restore — SPEC-0006's Focus Management
        requirement names the return, and a dialog written here would have
        to reimplement it and would get one of the three routes wrong.
      */}
      <Popover
        open={openNode !== null}
        onClose={onCloseControl}
        labelledBy={controlHeadingId}
      >
        {openNode !== null && (
          <NodeControl
            node={openNode}
            headingId={controlHeadingId}
            format={(quantity) =>
              formatQuantity(quantity, { groupSeparator: preferences.groupSeparator })
            }
            assignedTo={assignments[openNode.id] ?? null}
            onSelectMethod={(method) => {
              onSelectMethod(openNode.id, openNode.name, method);
            }}
            onAssign={(baseId) => {
              onAssign(openNode.id, openNode.name, baseId);
            }}
          />
        )}
      </Popover>
    </section>
  );
}
