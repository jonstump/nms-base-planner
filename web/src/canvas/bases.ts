/*
 * The bases a leaf can be assigned to.
 *
 * Governing: ADR-0004 (React view layer), SPEC-0006 REQ "Leaf Assignment to
 * Bases", REQ "Node Card"
 *
 * The six identity slots are the design's: `base.css` defines a colour
 * token for each, and SPEC-0006 REQ "Node Card" requires an assigned leaf
 * carry "a 3px border in that base's colour token". So the *set* is not
 * invented here.
 *
 * The names are placeholders and are the one thing here that is not
 * settled. A base's real name comes from the bases map, which has no spec
 * and no surface yet — the design handoff expects one ("base identity has
 * the name in the popover/base panel"). Until it exists a slot needs
 * something a player can say out loud, and "Base 3" is that without
 * pretending to be a name someone chose.
 *
 * The identifier is what crosses the boundary. `RollupRequest.assignments`
 * maps an item id to a base id, and the domain takes the id as an opaque
 * string — so the slot number is carried through rather than translated,
 * and a real registry can replace the label without touching what the
 * domain receives.
 */

import type { IdentitySlot } from "../card/BasePlannerCard";

export interface Base {
  readonly slot: IdentitySlot;
  /** What crosses the boundary. Opaque to the domain. */
  readonly id: string;
  /** Placeholder until the bases map exists. */
  readonly label: string;
}

export const BASES: readonly Base[] = Object.freeze(
  ([1, 2, 3, 4, 5, 6] as const).map((slot) =>
    Object.freeze({ slot, id: `base-${String(slot)}`, label: `Base ${String(slot)}` }),
  ),
);

/** The slot a leaf is showing, or undefined when it is unassigned. */
export function slotFor(
  assignments: Readonly<Record<string, string>>,
  itemId: string,
): IdentitySlot | undefined {
  const id = assignments[itemId];
  if (id === undefined) return undefined;
  return BASES.find((base) => base.id === id)?.slot;
}
