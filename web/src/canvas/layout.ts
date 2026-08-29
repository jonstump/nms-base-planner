/*
 * Where the nodes go.
 *
 * Governing: ADR-0004 (React view layer), SPEC-0006 REQ "Layout Geometry Is
 * Not a Domain Value", SPEC-0005 REQ "The View Computes No Domain Values"
 *
 * SPEC-0006 carves layout out of SPEC-0005's no-arithmetic rule and draws
 * the line at what the computation may read: "structure yes, quantities no".
 * A coordinate is not a domain figure and the domain reports none, so
 * computing one is presentation. Scaling a node by its total, or ordering a
 * column by quantity, would be deriving a visual fact from a domain value
 * and is named in the spec as prohibited.
 *
 * The line is kept by the types rather than by discipline. `LayoutNode` has
 * one string field and it is an id; `LayoutEdge` has three and they are all
 * ids. There is no field a `Quantity` could be put in without adding one,
 * which is a diff a reviewer sees — the same argument `ViewState` is built
 * on. `toElkGraph` is exported so a test can assert the exact key set that
 * reaches the engine rather than trusting the type to have held.
 *
 * Node size is a constant. It could legitimately vary with the length of a
 * name — that is structure — but a fixed size makes "changing quantity does
 * not move the graph" true by construction rather than by argument, and the
 * card is a fixed size in the design anyway.
 */

import type { ElkNode } from "elkjs/lib/elk.bundled.js";

/** A node, as the layout engine is allowed to see it. */
export interface LayoutNode {
  readonly id: string;
  readonly width: number;
  readonly height: number;
}

/** An edge, as the layout engine is allowed to see it. */
export interface LayoutEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
}

export interface Placement {
  readonly x: number;
  readonly y: number;
}

/**
 * The card's fixed footprint, in CSS pixels. Not derived from anything.
 *
 * Taller than the name-and-total card it started as, because SPEC-0006 puts
 * a method badge, a yield, an application count, an unassigned marker and a
 * provenance chip on it. Still a constant: sizing a card by its total is
 * named in the spec as a violation, and a fixed size is what makes "changing
 * quantity does not move the graph" true by construction.
 */
export const NODE_WIDTH = 210;
export const NODE_HEIGHT = 148;

/*
 * Left to right, layered.
 *
 * `RIGHT` is the direction the design draws: terminals on the left, the
 * target on the right, which is also the order the payload lists them in.
 * NETWORK_SIMPLEX is elk's default layering strategy and is deterministic
 * for a given input — which the byte-identical-positions test depends on.
 */
const OPTIONS: Readonly<Record<string, string>> = Object.freeze({
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.layered.spacing.nodeNodeBetweenLayers": "110",
  "elk.spacing.nodeNode": "28",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
});

/** The exact object handed to the engine. Exported so a test can inspect it. */
export function toElkGraph(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
): ElkNode {
  return {
    id: "root",
    layoutOptions: OPTIONS,
    children: nodes.map((node) => ({
      id: node.id,
      width: node.width,
      height: node.height,
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    })),
  };
}

/*
 * The engine, fetched the first time something actually needs laying out.
 *
 * `elk.bundled.js` is 1.6 MB — a GWT-compiled Java-to-JS blob, and on its
 * own an eightfold increase in the initial bundle when imported statically.
 * Measured: 222 kB to 1,864 kB raw, 69 kB to 575 kB gzipped.
 *
 * That is the same problem SPEC-0005 REQ "Module Loading" solves for the
 * WASM binary, and it gets the same answer for the same reason — a player
 * who has not resolved a plan yet should not pay to download a layout
 * engine. A dynamic import makes it its own chunk, fetched on the first
 * layout and cached after.
 *
 * It runs in-process rather than spawning a worker, which matters under the
 * shell's CSP: a worker built from a blob URL would need it widened.
 */
type Engine = InstanceType<typeof import("elkjs/lib/elk.bundled.js").default>;

let engine: Promise<Engine> | null = null;

function loadEngine(): Promise<Engine> {
  engine ??= import("elkjs/lib/elk.bundled.js").then((module) => new module.default());
  return engine;
}

/**
 * Positions for each node id, or `null` when the engine could not produce
 * them.
 *
 * `null` rather than an empty map, because the two are different facts and
 * the caller has to tell them apart. An empty map is a legitimate answer —
 * a graph with no nodes has no placements — and if failure returned one too
 * the caller's only options would be to draw an unplaced graph or to refuse
 * to draw an empty one.
 *
 * Drawing an unplaced graph is the specific outcome that matters: every
 * node falls back to the same coordinate and thirty-six cards render as one
 * pile at the origin, which reads as a rendering fault rather than as a
 * failure the player can act on. The engine is a lazily fetched 1.6 MB
 * chunk in an application that is meant to work offline, so losing it is a
 * real state and not a theoretical one.
 *
 * Still not a throw. A canvas that cannot lay out should report itself, not
 * take the surface down with it.
 */
export async function layoutGraph(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
): Promise<ReadonlyMap<string, Placement> | null> {
  if (nodes.length === 0) return new Map();

  const placements = new Map<string, Placement>();
  try {
    const elk = await loadEngine();
    const laid = (await elk.layout(toElkGraph(nodes, edges))) as {
      children?: { id?: string; x?: number; y?: number }[];
    };
    for (const child of laid.children ?? []) {
      if (typeof child.id !== "string") continue;
      placements.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
    }
  } catch {
    return null;
  }

  /*
   * A layout that came back without a placement for every node is a failed
   * layout, not a partial one — the missing nodes would take the fallback
   * coordinate and pile up exactly as above.
   */
  if (placements.size !== nodes.length) return null;

  return placements;
}
