import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { ReactNode } from "react";

import type { CanvasNode } from "./graph-model";

/*
 * Handles are anchor points the edge renderer needs in the DOM; nothing
 * needs to see them. Hidden here rather than in canvas.css because the
 * override would have to name React Flow's own `react-flow__handle` class,
 * and reaching into a third-party selector to undo its styling is how a
 * stylesheet acquires a dependency on someone else's internals.
 */
const ANCHOR = Object.freeze({ opacity: 0, border: 0 });

/*
 * One node, as a card.
 *
 * Governing: ADR-0004 (React view layer), SPEC-0006 REQ "Graph Rendering
 * From the Boundary Payload", Accessibility Requirements → Keyboard
 * Navigation, SPEC-0005 REQ "The View Computes No Domain Values"
 *
 * Deliberately minimal. This story renders the graph — identity, yield and
 * provenance are the node-card story's, and the method and recipe controls
 * are their own. What is here is what an edge needs to connect to and what
 * the layout needs to place.
 *
 * A `<button>`, so the node is one tab stop. React Flow is mounted with
 * `nodesFocusable={false}` for the same reason: its own wrapper would take
 * a tab stop of its own and every node would cost two.
 *
 * The total is printed as it arrived. `formatQuantity` groups digits and
 * does not parse — SPEC-0005 keeps quantities as exact strings end to end,
 * and this is the last point before a screen.
 */

export interface NodeCardData extends Record<string, unknown> {
  readonly node: CanvasNode;
  readonly display: string;
}

export function NodeCard({ data }: NodeProps): ReactNode {
  const { node, display } = data as unknown as NodeCardData;

  return (
    <>
      {/*
        Handles carry no meaning and are not interactive — the canvas mounts
        with `nodesConnectable={false}`. They are anchor points the edge
        renderer needs, hidden from assistive technology so the node reads
        as one thing.
      */}
      <Handle
        type="target"
        position={Position.Left}
        style={ANCHOR}
        aria-hidden="true"
        isConnectable={false}
      />

      <button type="button" className="node-card interactive" data-method={node.method}>
        <span className="node-name">{node.name}</span>
        <span className="numeral node-total">{display}</span>
        <span className="node-method">{node.method}</span>
      </button>

      <Handle
        type="source"
        position={Position.Right}
        style={ANCHOR}
        aria-hidden="true"
        isConnectable={false}
      />
    </>
  );
}
