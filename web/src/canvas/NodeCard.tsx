import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { CSSProperties, ReactNode } from "react";

import type { IdentitySlot } from "../card/BasePlannerCard";
import { StatusBadge } from "../shell/StatusBadge";
import type { CanvasNode } from "./graph-model";

/*
 * What a node says about itself.
 *
 * Governing: ADR-0004 (React view layer), SPEC-0006 REQ "Node Card",
 * REQ "Yield and Application Display", REQ "Provenance Display",
 * SPEC-0005 REQ "The View Computes No Domain Values", Accessibility
 * Requirements
 *
 * A `<button>`, so the node is one tab stop. React Flow is mounted with
 * `nodesFocusable={false}` for the same reason: its own wrapper would take
 * a tab stop of its own and every node would cost two.
 *
 * Every quantity is printed as it arrived. `formatQuantity` groups digits
 * and does not parse — SPEC-0005 keeps quantities as exact strings end to
 * end, and this is the last point before a screen.
 *
 * The border carries base identity and nothing else. That is the whole
 * reason SPEC-0005's interaction primitives are shaped the way they are —
 * hover a filter, focus an outboard outline, selection an overlay ring —
 * and they are inherited from base.css here rather than restated. A card
 * that is assigned, hovered, focused and selected at once shows all four,
 * because only one of them is written with a border.
 */

/** The handles are anchor points for the edge renderer, not controls. */
const ANCHOR: CSSProperties = { opacity: 0, pointerEvents: "none" };

/*
 * Method as a glyph and a word, from the design handoff's own set.
 *
 * SPEC-0006: "its resolved method as a badge carrying both a glyph and a
 * text label". The word is the accessible carrier and the glyph is the
 * visual one, the same division StatusBadge makes — so the glyph is hidden
 * from assistive technology, which would otherwise read "white down-pointing
 * triangle".
 *
 * A method the payload sends that is not in this table still renders, with
 * its word and no glyph. The domain's methods are raw, craft and refine
 * today; a fourth arriving should show up as an unfamiliar badge rather
 * than as a card that throws.
 */
const METHOD_GLYPH: Readonly<Record<string, string>> = Object.freeze({
  raw: "▽",
  craft: "⚒",
  refine: "◇",
});

export interface NodeCardData extends Record<string, unknown> {
  readonly node: CanvasNode;
  /** The total, grouped for display. */
  readonly display: string;
  /** The recipe's yield, when it is not 1. Absent otherwise. */
  readonly yieldDisplay: string | null;
  /**
   * Open this node's control.
   *
   * SPEC-0006 REQ "Method Selection": "Clicking or pressing Enter on a node
   * MUST open a control". The card is a `<button>`, so Enter and Space
   * already arrive here as clicks — there is no key handler, which is what
   * keeps the pointer and keyboard routes from being able to disagree.
   */
  readonly onOpen: (nodeId: string) => void;
  /** The application count, exact and unrounded. Absent for a terminal. */
  readonly applicationsDisplay: string | null;
  /**
   * Which base owns this leaf.
   *
   * A prop rather than a payload field because assignment is plan state
   * that reaches the view through an entry point SPEC-0006 REQ "Leaf
   * Assignment to Bases" leaves for a later story. Until then every leaf
   * renders unassigned, which is the truth: nothing has assigned one.
   *
   * The type is the base card's, imported rather than restated. There is
   * one categorical palette and one meaning for slot 4; a second copy of
   * the type is a second place for the two to disagree.
   */
  readonly identity?: IdentitySlot;
}

function MethodBadge({ method }: { readonly method: string }): ReactNode {
  const glyph = METHOD_GLYPH[method];
  return (
    <span className="node-method label">
      {glyph !== undefined && (
        <span aria-hidden="true" className="node-method-glyph">
          {glyph}
        </span>
      )}
      <span>{method}</span>
    </span>
  );
}

/*
 * A figure the total alone does not carry.
 *
 * SPEC-0006: a total of 300 through a recipe yielding 50 is a different
 * build instruction from a total of 300 through a recipe yielding 1, and
 * the card as drawn shows only the total. The label is text, not a glyph,
 * because there is no established symbol for either of these.
 */
function Figure({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): ReactNode {
  return (
    <span className="node-figure">
      <span className="node-figure-label label">{label}</span>{" "}
      <span className="numeral node-figure-value">{value}</span>
    </span>
  );
}

export function NodeCard({ data }: NodeProps): ReactNode {
  const { node, display, yieldDisplay, applicationsDisplay, identity, onOpen } =
    data as unknown as NodeCardData;

  /*
   * Three border states and no fourth. A leaf carries the 3px identity
   * frame — its base's colour when assigned, dashed neutral when not — and
   * a non-leaf carries the 1px neutral border. `.identity` and its slot
   * classes are base.css's, so the frame this card draws is the same frame
   * the base planner card draws.
   */
  const frame = !node.terminal
    ? "node-card-plain"
    : identity === undefined
      ? "identity identity-unassigned"
      : `identity identity-${String(identity)}`;

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

      <button
        type="button"
        className={`node-card interactive selectable ${frame}`}
        data-method={node.method}
        aria-haspopup="dialog"
        onClick={() => {
          onOpen(node.id);
        }}
        /* Only a leaf can be assigned, so only a leaf carries the attribute.
         * A non-leaf marked "unassigned" would be describing a state it
         * cannot be in. */
        data-identity={
          !node.terminal
            ? undefined
            : identity === undefined
              ? "unassigned"
              : String(identity)
        }
      >
        <span className="node-name">{node.name}</span>
        <span className="numeral node-total">{display}</span>

        <span className="node-facts">
          <MethodBadge method={node.method} />
          {yieldDisplay !== null && <Figure label="yield" value={yieldDisplay} />}
          {applicationsDisplay !== null && (
            <Figure label="apps" value={applicationsDisplay} />
          )}
        </span>

        {/*
          The unassigned state, with a second carrier.

          SPEC-0006: "it shows a dashed border and a warning dot, and the
          state is legible without colour perception". The dashed frame is
          one non-colour carrier and the dot's own label is the other — the
          dot's colour is reinforcement, not the fact.
        */}
        {node.terminal && identity === undefined && (
          <span className="node-unassigned">
            <span aria-hidden="true" className="node-warning-dot" />
            <span className="label">Unassigned</span>
          </span>
        )}

        {/*
          Provenance, and deliberately not an alarm.

          SPEC-0006 REQ "Provenance Display" requires the marker state that
          the data is community-sourced and not verified in-game, and
          requires it not be styled as an error. SPEC-0001 propagates the
          flag to every ancestor, so the normal case is a connected span up
          to the target rather than an isolated chip — which is why this is
          a muted dashed chip and not the warning or deficit treatment.

          StatusBadge's `unverified` member is reused rather than restyled:
          its glyph and its word are the same ones the figure list uses for
          the same fact, and its colour is `--text-muted`, which is neither
          `--warn` nor `--danger`. The full sentence rides on the badge's
          own detail slot so the marker states it rather than implying it.
        */}
        {!node.verified && (
          <span className="node-provenance">
            <StatusBadge
              status="unverified"
              detail="community data, not verified in-game"
            />
          </span>
        )}
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
