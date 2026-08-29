import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type EdgeProps,
} from "@xyflow/react";
import type { ReactNode } from "react";

/*
 * One edge, carrying its per-unit quantity.
 *
 * Governing: SPEC-0006 REQ "Edge Rendering"
 *
 * "An edge MUST carry the per-unit quantity relating its two nodes, taken
 * from the payload." It is rendered as text on the edge, not encoded in
 * thickness or colour — a width proportional to a quantity would be a
 * visual fact derived from a domain value, which SPEC-0006 prohibits, and
 * would also be unreadable.
 *
 * "The method of the node an edge feeds MUST be readable from the edge
 * itself as well as from the node's badge." `data-method` drives the stroke
 * treatment, and the same word is in the label's title text — so the fact
 * survives someone who cannot tell a dashed line from a solid one.
 *
 * "Edge styling MUST be decorative reinforcement only." Nothing here is the
 * sole carrier of anything: the per-unit figure is text, the method is text
 * on the label and text again on the card it feeds.
 */

export interface TreeEdgeData extends Record<string, unknown> {
  readonly perUnit: string;
  readonly targetMethod: string;
  readonly sourceName: string;
  readonly targetName: string;
}

export function TreeEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps): ReactNode {
  const edge = data as unknown as TreeEdgeData | undefined;
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const method = edge?.targetMethod ?? "";
  const perUnit = edge?.perUnit ?? "";

  return (
    <>
      <BaseEdge id={id} path={path} className="tree-edge" data-method={method} />
      <EdgeLabelRenderer>
        <span
          className="edge-label numeral"
          data-method={method}
          style={{
            transform: `translate(-50%, -50%) translate(${String(labelX)}px, ${String(labelY)}px)`,
          }}
          title={`${perUnit} per unit, feeding a ${method} step`}
        >
          {perUnit}
        </span>
      </EdgeLabelRenderer>
    </>
  );
}
