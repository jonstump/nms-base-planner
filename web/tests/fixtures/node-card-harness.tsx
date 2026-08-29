/*
 * The node card in the states the shipped artifact cannot produce.
 *
 * Governing: SPEC-0006 REQ "Node Card", REQ "Yield and Application Display",
 * REQ "Provenance Display"
 *
 * Two of this story's three requirements describe states the real data will
 * not reach. design.md says so outright about the third: "The generated
 * artifact marks nothing unverified — resolving ULTRAPROD2 against
 * data/tier1.json returns 36 nodes, 0 of them unverified — because the
 * normalizer never emits `"verified": false`." Confirmed by resolving both
 * targets and counting: zero, twice. Base assignment is the same story from
 * the other end — SPEC-0006 REQ "Leaf Assignment to Bases" leaves the entry
 * point for a later story, so nothing can assign a leaf yet.
 *
 * A suite that only drove the application would therefore assert that the
 * marker is absent and that every leaf is unassigned, and pass forever
 * against a card that could not draw either one.
 *
 * So the fixture mounts the real `NodeCard` through a real `ReactFlow`,
 * exactly as `TreeCanvas` does — same node type, same props, same handles —
 * and hands it the states the artifact will not. What it does not do is
 * re-implement the card: a fixture that drew its own markup would test the
 * fixture.
 *
 * The unverified nodes are a connected span rather than a scattering,
 * because SPEC-0001 propagates the flag to every ancestor and design.md is
 * explicit that "the design tuned 'subtle, honest, non-alarming' against two
 * instances in a prototype; propagation means the real count is a spine, not
 * a pair."
 */

import { ReactFlow, type Node } from "@xyflow/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@xyflow/react/dist/base.css";

import { asQuantity, formatQuantity, type Quantity } from "../../src/boundary";
import type { IdentitySlot } from "../../src/card/BasePlannerCard";
import type { CanvasNode } from "../../src/canvas/graph-model";
import { NODE_HEIGHT, NODE_WIDTH } from "../../src/canvas/layout";
import { NodeCard, type NodeCardData } from "../../src/canvas/NodeCard";

import "../../src/styles/tokens.css";
import "../../src/styles/base.css";
import "../../src/styles/shell.css";
import "../../src/styles/canvas.css";

/** Exact strings in, exact strings out. A bad literal fails the fixture loudly. */
function exact(value: string): Quantity {
  const quantity = asQuantity(value);
  if (quantity === null) throw new Error(`fixture quantity is not exact: ${value}`);
  return quantity;
}

interface Spec {
  readonly id: string;
  readonly name: string;
  readonly total: string;
  readonly method: string;
  readonly recipeYield: string | null;
  readonly applications: string | null;
  readonly terminal: boolean;
  readonly verified: boolean;
  readonly identity?: IdentitySlot;
}

/*
 * Six leaves across all six identity slots, an unassigned leaf, a non-leaf,
 * a fractional application count, a yield of exactly 1 (which must NOT
 * show), and a three-node unverified span.
 *
 * The slot-6 leaf is deliberate: purple is the palette's contrast floor and
 * the reason the card sits on `--panel` rather than `--panel-raised`.
 */
const SPECS: readonly Spec[] = [
  {
    id: "SLOT1",
    name: "Ferrite Dust",
    total: "1200",
    method: "raw",
    recipeYield: null,
    applications: null,
    terminal: true,
    verified: true,
    identity: 1,
  },
  {
    id: "SLOT2",
    name: "Carbon",
    total: "800",
    method: "raw",
    recipeYield: null,
    applications: null,
    terminal: true,
    verified: true,
    identity: 2,
  },
  {
    id: "SLOT3",
    name: "Sodium",
    total: "640",
    method: "raw",
    recipeYield: null,
    applications: null,
    terminal: true,
    verified: true,
    identity: 3,
  },
  {
    id: "SLOT4",
    name: "Oxygen",
    total: "500",
    method: "raw",
    recipeYield: null,
    applications: null,
    terminal: true,
    verified: true,
    identity: 4,
  },
  {
    id: "SLOT5",
    name: "Paraffinium",
    total: "450",
    method: "raw",
    recipeYield: null,
    applications: null,
    terminal: true,
    verified: true,
    identity: 5,
  },
  {
    id: "SLOT6",
    name: "Dioxite",
    total: "300",
    method: "raw",
    recipeYield: null,
    applications: null,
    terminal: true,
    verified: true,
    identity: 6,
  },
  {
    id: "UNASSIGNED",
    name: "Silver",
    total: "918273",
    method: "raw",
    recipeYield: null,
    applications: null,
    terminal: true,
    verified: true,
  },
  {
    /* A yield of exactly 1 is the absence of the fact, not a line on the card. */
    id: "UNIT_YIELD",
    name: "Antimatter",
    total: "1",
    method: "craft",
    recipeYield: "1",
    applications: "1",
    terminal: false,
    verified: true,
  },
  {
    /* The real shape: Chromatic Metal in the Antimatter tree yields 30 per
     * application and needs 5/6 of one. Neither figure is derivable from
     * the total, and 5/6 is what must not become 1. */
    id: "FRACTIONAL",
    name: "Chromatic Metal",
    total: "25",
    method: "refine",
    recipeYield: "30",
    applications: "5/6",
    terminal: false,
    verified: true,
  },
  {
    id: "UNVERIFIED_LEAF",
    name: "Frost Crystal",
    total: "200",
    method: "raw",
    recipeYield: null,
    applications: null,
    terminal: true,
    verified: false,
  },
  {
    id: "UNVERIFIED_MID",
    name: "Glass",
    total: "40",
    method: "refine",
    recipeYield: "5",
    applications: "8",
    terminal: false,
    verified: false,
  },
  {
    id: "UNVERIFIED_TARGET",
    name: "Living Glass",
    total: "5",
    method: "craft",
    recipeYield: "1",
    applications: "5",
    terminal: false,
    verified: false,
  },
];

function toNode(spec: Spec, index: number): Node {
  const node: CanvasNode = {
    id: spec.id,
    name: spec.name,
    total: exact(spec.total),
    method: spec.method,
    recipeYield: spec.recipeYield === null ? null : exact(spec.recipeYield),
    applications: spec.applications === null ? null : exact(spec.applications),
    terminal: spec.terminal,
    verified: spec.verified,
  };

  /* `identity` is spread rather than assigned, because the project builds
   * with exactOptionalPropertyTypes: an absent slot is an absent property,
   * not a property holding undefined. */
  const data: NodeCardData = {
    ...(spec.identity === undefined ? {} : { identity: spec.identity }),
    node,
    display: formatQuantity(node.total, { groupSeparator: "," }),
    yieldDisplay:
      node.recipeYield === null || node.recipeYield === "1"
        ? null
        : formatQuantity(node.recipeYield, { groupSeparator: "," }),
    applicationsDisplay:
      node.applications === null
        ? null
        : formatQuantity(node.applications, { groupSeparator: "," }),
  };

  return {
    id: spec.id,
    type: "card",
    /* Laid out by hand: elkjs is not what this fixture is about, and a
     * fixed grid keeps every card on screen for the audit. */
    position: {
      x: (index % 4) * (NODE_WIDTH + 40),
      y: Math.floor(index / 4) * (NODE_HEIGHT + 40),
    },
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
    draggable: false,
    selectable: false,
    data,
  };
}

const NODE_TYPES = { card: NodeCard };

function Harness(): React.ReactNode {
  return (
    <section className="tree-canvas" aria-label="Dependency tree">
      <ReactFlow
        nodes={SPECS.map(toNode)}
        edges={[]}
        nodeTypes={NODE_TYPES}
        nodesFocusable={false}
        nodesConnectable={false}
        nodesDraggable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        fitView
        proOptions={{ hideAttribution: false }}
      />
    </section>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("fixture root is missing");

createRoot(root).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
