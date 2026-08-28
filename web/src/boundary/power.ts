/*
 * The stage 3 power payload: one base's power position.
 *
 * Governing: ADR-0004 (React view layer), SPEC-0002 REQ "Exact Quantity
 * Encoding", SPEC-0005 REQ "The View Computes No Domain Values",
 * SPEC-0007 REQ "Power Position", REQ "Deficit Is an Action, Including When
 * It Cannot Be Sized"
 *
 * `balance` and `deficit` both cross as the domain's own values — the
 * adapter does not subtract, and neither does this. SPEC-0007 forbids the
 * card computing a balance, a percentage or a meter proportion from the two
 * figures as displayed.
 *
 * `fixUnsized` is decoded as its own field and never inferred from a zero
 * generator count. It reports that a deficit exists but no class is
 * configured to size the fix with, and design.md warns that an implementer
 * working from the prototype alone would meet a budget in deficit with
 * `additionalGenerators` of zero and reasonably conclude there was nothing
 * to show.
 */

import { flag, list, object, quantity, text, type Raw } from "./decode";
import type { Quantity } from "./quantity";

export interface PowerBudget {
  readonly base: string;

  readonly generation: Quantity;
  readonly draw: Quantity;

  /** Generation minus draw, and may be negative. The domain's own value. */
  readonly balance: Quantity;
  /** The shortfall as a positive figure, or zero. Also the domain's. */
  readonly deficit: Quantity;
  readonly inDeficit: boolean;

  readonly perGenerator: Quantity;
  readonly batteries: Quantity;

  /** How many more generators at this base's class would clear the deficit. */
  readonly additionalGenerators: Quantity;
  /**
   * A deficit exists but no class is configured to cost the fix with.
   *
   * Distinct from `additionalGenerators` being zero because there is no
   * deficit. A card must show the deficit either way and must not present
   * an unsized fix as an actionable count.
   */
  readonly fixUnsized: boolean;

  readonly verified: boolean;
}

export interface Power {
  readonly bases: readonly PowerBudget[];
}

function decodeBudget(value: unknown): PowerBudget | null {
  const raw = object(value);
  if (!raw) return null;

  const base = text(raw["base"]);
  const generation = quantity(raw["generation"]);
  const draw = quantity(raw["draw"]);
  const balance = quantity(raw["balance"]);
  const deficit = quantity(raw["deficit"]);
  const perGenerator = quantity(raw["perGenerator"]);
  const batteries = quantity(raw["batteries"]);
  const additionalGenerators = quantity(raw["additionalGenerators"]);
  const inDeficit = flag(raw["inDeficit"]);
  const fixUnsized = flag(raw["fixUnsized"]);
  const verified = flag(raw["verified"]);

  if (base === null || generation === null || draw === null) return null;
  if (balance === null || deficit === null) return null;
  if (perGenerator === null || batteries === null || additionalGenerators === null)
    return null;
  if (inDeficit === null || fixUnsized === null || verified === null) return null;

  return {
    base,
    generation,
    draw,
    balance,
    deficit,
    inDeficit,
    perGenerator,
    batteries,
    additionalGenerators,
    fixUnsized,
    verified,
  };
}

/** Pull `data.power` out of a result payload, or return null. */
export function selectPower(data: unknown): Power | null {
  const payload = object(data);
  const raw: Raw | null = payload === null ? null : object(payload["power"]);
  if (!raw) return null;

  if (!Array.isArray(raw["bases"])) return null;
  const bases = list(raw["bases"], decodeBudget);
  return bases === null ? null : { bases };
}
