/*
 * The payload, as the canvas renders it.
 *
 * Governing: ADR-0004 (React view layer), SPEC-0006 REQ "Graph Rendering
 * From the Boundary Payload", REQ "Layout Geometry Is Not a Domain Value",
 * REQ "Edge Rendering"
 *
 * Two conversions, kept apart on purpose.
 *
 * `toCanvasModel` is the whole payload flattened for rendering: names,
 * totals, methods, and one edge per entry in each node's `children`. It
 * preserves the payload's node order exactly — terminals first, target last
 * — because SPEC-0006 requires the canvas take that order as given, and
 * because that order is also the tab order. There is no comparator in this
 * file and there must not be one: deriving an order here would be a second
 * place for it to drift from the domain's.
 *
 * `toLayoutInput` throws almost all of that away. It is the only thing the
 * layout engine sees, and it is a separate function rather than an inline
 * `.map` at the call site so that the line SPEC-0006 draws is a thing a
 * test can hold and read rather than an argument about a call site.
 *
 * Edge direction: a node's `children` are the inputs it consumes, so an
 * edge runs from the input to the consumer. That puts terminals on the left
 * and the target on the right under a RIGHT-directed layout, which is the
 * order the payload lists them in and the direction the design draws.
 */

import type { Quantity, ResolvedGraph } from "../boundary";
import { NODE_HEIGHT, NODE_WIDTH, type LayoutEdge, type LayoutNode } from "./layout";

export interface CanvasNode {
  readonly id: string;
  readonly name: string;
  readonly total: Quantity;
  readonly method: string;
  /** The resolved recipe's yield per application. Absent for a terminal. */
  readonly recipeYield: Quantity | null;
  /**
   * How many applications of the recipe the total needs — exact, and not a
   * whole number of crafting operations. SPEC-0006 forbids rounding it and
   * SPEC-0001 confines rounding to enumerated physical boundaries, which
   * this is not one of.
   */
  readonly applications: Quantity | null;
  readonly terminal: boolean;
  readonly verified: boolean;

  /**
   * The methods the domain reports as legal for this node.
   *
   * Carried verbatim. SPEC-0006 REQ "Method Selection" forbids the canvas
   * computing which methods are legal, so this is the only thing the
   * control consults — see canvas/methods.ts.
   */
  readonly legalMethods: readonly string[];

  /**
   * What this node consumes, named, for the control's consequence line.
   *
   * Built from the node's own `children` — the same source the edges come
   * from — so the control states the current route in the domain's terms
   * without a second crossing.
   */
  readonly inputs: readonly { readonly name: string; readonly perUnit: Quantity }[];
}

export interface CanvasEdge {
  readonly id: string;
  /** The input being consumed. */
  readonly source: string;
  /** The node consuming it. */
  readonly target: string;
  readonly perUnit: Quantity;
  /**
   * The method of the node this edge feeds.
   *
   * SPEC-0006 REQ "Edge Rendering": the method "MUST be readable from the
   * edge itself as well as from the node's badge, so the wiring reinforces
   * the fact rather than the badge carrying it alone". Carried on the edge
   * so the styling has something local to key off, and stated as text on
   * the edge as well — the same requirement forbids a fact living only in
   * an edge's appearance.
   */
  readonly targetMethod: string;
}

export interface CanvasModel {
  readonly nodes: readonly CanvasNode[];
  readonly edges: readonly CanvasEdge[];
}

export function toCanvasModel(graph: ResolvedGraph): CanvasModel {
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];

  /*
   * Names for the control's consequence line. A plain lookup over the same
   * payload — not a second source, and not an ordering: the iteration below
   * still walks `graph.nodes` in the payload's order and nothing is sorted.
   */
  const nameOf = new Map<string, string>();
  for (const node of graph.nodes) nameOf.set(node.itemId, node.name);

  for (const node of graph.nodes) {
    nodes.push({
      id: node.itemId,
      name: node.name,
      total: node.total,
      method: node.method,
      recipeYield: node.yield,
      applications: node.applications,
      terminal: node.terminal,
      verified: node.verified,
      legalMethods: node.legalMethods,
      inputs: node.children.map((child) => ({
        name: nameOf.get(child.to) ?? child.to,
        perUnit: child.perUnit,
      })),
    });

    /*
     * Only from this node's own children. SPEC-0006: "the canvas MUST NOT
     * infer an edge that the payload does not contain" — so there is no
     * reverse pass, no transitive closure, and no edge to a node that
     * happens to look like a plausible input.
     */
    for (const child of node.children) {
      edges.push({
        id: `${child.to}->${node.itemId}`,
        source: child.to,
        target: node.itemId,
        perUnit: child.perUnit,
        targetMethod: node.method,
      });
    }
  }

  return { nodes, edges };
}

/**
 * Structure, and nothing else.
 *
 * Governing: SPEC-0006 REQ "Layout Geometry Is Not a Domain Value" — "its
 * input is nodes and edges, and no node total, yield or application count
 * is passed to it".
 *
 * Width and height are the constants from layout.ts, identical for every
 * node. Sizing a card by its total is named in the spec as a violation, and
 * a fixed size is what makes "changing quantity does not move the graph"
 * true by construction.
 */
export function toLayoutInput(model: CanvasModel): {
  readonly nodes: readonly LayoutNode[];
  readonly edges: readonly LayoutEdge[];
} {
  return {
    nodes: model.nodes.map((node) => ({
      id: node.id,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    })),
    edges: model.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
    })),
  };
}
