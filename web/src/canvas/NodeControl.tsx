import type { ReactNode } from "react";

import type { Quantity } from "../boundary";
import type { CanvasNode } from "./graph-model";
import { methodOptions } from "./methods";

/*
 * The node's control: how this item is made.
 *
 * Governing: ADR-0004 (React view layer), ADR-0005 (multiple recipes per
 * output), SPEC-0006 REQ "Method Selection", Accessibility Requirements →
 * Keyboard Navigation, Focus Management
 *
 * Method only. The recipe half of SPEC-0006's control is issue #132 and is
 * blocked on design rather than on code: the handoff contains no mention of
 * "recipe", the spec requires an implementation carry the design's answer,
 * and the segmented control below is drawn for two options against data
 * that reaches sixty-one. Stretching it here is the thing the spec names.
 *
 * The content only. `Popover` owns the dialog, the backdrop, the focus trap
 * and the return — this renders inside it and never touches focus, which is
 * what keeps every close route converging on one restore.
 *
 * Nothing here decides what is legal. `methodOptions` reads `legalMethods`
 * off the payload and marks everything else inert; there is no branch on
 * `terminal`, no check for children, and no item table.
 */

export interface NodeControlProps {
  readonly node: CanvasNode;
  readonly headingId: string;
  readonly onSelectMethod: (method: string) => void;
  /** Grouping only — `formatQuantity` never parses. */
  readonly format: (quantity: Quantity) => string;
}

export function NodeControl({
  node,
  headingId,
  onSelectMethod,
  format,
}: NodeControlProps): ReactNode {
  const options = methodOptions(node.legalMethods, node.method, node.name);

  return (
    <div className="node-control">
      <h3 id={headingId} className="node-control-title">
        {node.name}
      </h3>

      {/*
        The consequence, stated before the change and in the domain's own
        terms — SPEC-0006 requires it, and the design's example is a route
        description rather than a confirmation prompt.

        What is stated is the route the payload actually reports: the
        current method, its yield, and what it consumes per unit. What is
        NOT stated is what a different method would cost, because the
        payload carries no figures for a route the planner did not resolve.
        Inventing them would be the view computing a domain value, which is
        the rule this whole surface is built under — so the second line
        names the effect instead, which is true and checkable.
      */}
      <p className="node-control-now">
        <span className="label">Now</span>{" "}
        <span className="node-control-method">{node.method}</span>
        {node.recipeYield !== null && (
          <>
            {" · "}
            <span className="numeral">{format(node.recipeYield)}</span> per application
          </>
        )}
      </p>

      {node.inputs.length > 0 && (
        <ul className="node-control-inputs">
          {node.inputs.map((input) => (
            <li key={input.name}>
              <span className="numeral">{format(input.perUnit)}</span> {input.name} per
              unit
            </li>
          ))}
        </ul>
      )}

      <fieldset className="node-control-methods">
        <legend className="label">Method</legend>
        <div className="control-row-sm" role="group">
          {options.map((option) => (
            <button
              key={option.method}
              type="button"
              className="control control-sm interactive node-method-option"
              aria-pressed={option.current}
              /*
               * `disabled` rather than hidden, and the reason is rendered
               * below rather than put in a title attribute — a tooltip is
               * unreachable by keyboard and unreadable by a screen reader
               * on a disabled control.
               */
              disabled={!option.available}
              aria-describedby={
                option.reason === null ? undefined : `${headingId}-${option.method}`
              }
              onClick={() => {
                onSelectMethod(option.method);
              }}
            >
              {option.method}
            </button>
          ))}
        </div>

        {options
          .filter((option) => option.reason !== null)
          .map((option) => (
            <p
              key={option.method}
              id={`${headingId}-${option.method}`}
              className="label node-method-reason"
            >
              {option.reason}
            </p>
          ))}
      </fieldset>

      <p className="label node-control-effect">
        Changing the method re-resolves the plan. Every total below this node is
        recomputed by the planner.
      </p>
    </div>
  );
}
