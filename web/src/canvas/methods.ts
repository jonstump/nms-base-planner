/*
 * The method options a node offers, and which of them are inert.
 *
 * Governing: ADR-0004 (React view layer), ADR-0005 (multiple recipes per
 * output), SPEC-0006 REQ "Method Selection", SPEC-0005 REQ "The View
 * Computes No Domain Values"
 *
 * "The options offered MUST be the node's `legalMethods` from the payload;
 * the canvas MUST NOT compute which methods are legal."
 *
 * The distinction this file turns on: knowing that the *vocabulary* is
 * raw / craft / refine is not computing legality. The design fixes that set
 * ("Methods are craft / refine / raw", and there is deliberately no buy).
 * Which of them apply to a given item is a domain fact, and the only source
 * consulted for it is `legalMethods` — there is no table here mapping items
 * to methods, no terminal-implies-raw shortcut, and no inference from the
 * presence of children.
 *
 * The order is the design's, not the payload's, and that is deliberate: a
 * segmented control whose buttons move between nodes is a control a player
 * has to re-read every time. A method the payload reports that this file
 * has never heard of is still offered — appended in payload order — because
 * dropping it would be the canvas deciding what is legal by omission.
 */

/** The design's vocabulary. Not a legality table. */
export const METHOD_ORDER: readonly string[] = Object.freeze(["raw", "craft", "refine"]);

export interface MethodOption {
  readonly method: string;
  /** Reported by the payload as legal for this node. Never inferred. */
  readonly available: boolean;
  /** The node's resolved method, per the payload. */
  readonly current: boolean;
  /** Why the option is inert. Null when it is selectable. */
  readonly reason: string | null;
}

/**
 * Every method, with the unavailable ones present and inert.
 *
 * SPEC-0006: "A method that is not available for the node MUST be rendered
 * and inert, with the reason stated, rather than hidden. A hidden option
 * cannot be distinguished from one that does not exist."
 *
 * The reason is a statement about the payload rather than an explanation
 * invented here. The domain does not send a rationale, and a view that
 * wrote one — "ores cannot be crafted" — would be asserting a domain rule
 * it does not own and would be wrong the first time the data disagreed.
 */
export function methodOptions(
  legalMethods: readonly string[],
  current: string,
  name: string,
): MethodOption[] {
  const legal = new Set(legalMethods);
  const extra = legalMethods.filter((method) => !METHOD_ORDER.includes(method));

  return [...METHOD_ORDER, ...extra].map((method) => {
    const available = legal.has(method);
    return {
      method,
      available,
      current: method === current,
      reason: available ? null : `The planner reports no ${method} route for ${name}.`,
    };
  });
}
