/*
 * The places a leaf can be assigned to.
 *
 * Governing: ADR-0010 (places are authored first, and a plan assigns leaves
 * to places that exist), ADR-0004 (React view layer), SPEC-0011 REQ "A Place
 * Is Authored, and a Plan References It", SPEC-0006 REQ "Leaf Assignment to
 * Bases", REQ "Node Card"
 *
 * This file used to mint six identifiers — `base-1` through `base-6` — with
 * placeholder labels, on the grounds that a base's real name came from a
 * bases map that had no spec and no surface. That is no longer true, and the
 * ids were the thing SPEC-0011 forbids:
 *
 *   "The application MUST NOT mint a second identifier for a place, and MUST
 *   NOT derive a place's identity from a plan's assignments."
 *
 * So the assignable set is the workspace's places. `Base.id` is the
 * SPEC-0009 place record's own `id`, which ADR-0010 makes the same value the
 * domain receives as `BaseID`. Nothing here generates an identifier.
 *
 * The identity slot is the one thing still assigned here, and it is not
 * identity: it is which of the six colour tokens `base.css` defines this
 * place draws with. A colour is a rendering choice with six values and a
 * workspace may hold more than six places, so it is derived from position
 * and repeats. Identity is the id; the slot is paint.
 */

import type { IdentitySlot } from "../card/BasePlannerCard";
import type { PlaceRecord } from "../store";

export interface Base {
  /** The place record's own id. What crosses the boundary as BaseID. */
  readonly id: string;
  /** What the player called it, or the designed stand-in for a place they did not name. */
  readonly label: string;
  /** Which colour token this place draws with. Presentation, not identity. */
  readonly slot: IdentitySlot;
}

/**
 * What a place with no name is called on screen.
 *
 * A place is creatable with a name by rule (SPEC-0011 REQ "A Place Is
 * Creatable by Hand" makes the name the minimum), so this covers a record
 * written by an earlier path rather than a state the create route produces.
 * A stand-in rather than the raw id: an id is not a thing a player can say
 * out loud, and showing one reads as a fault.
 */
export const UNNAMED_PLACE = "Unnamed place";

const SLOTS: readonly IdentitySlot[] = [1, 2, 3, 4, 5, 6];

/**
 * The assignable bases, in the store's order.
 *
 * Governing: SPEC-0011 REQ "A Place Is Authored, and a Plan References It"
 *
 * An empty workspace yields an empty list, and that is a designed state
 * rather than a gap: a plan MUST remain resolvable when it references no
 * places at all, so the assignment control offers only "Unassigned" until
 * the player creates one.
 */
export function basesFrom(places: readonly PlaceRecord[]): readonly Base[] {
  return places.map((place, index) => ({
    id: place.id,
    label: place.name ?? UNNAMED_PLACE,
    // Wraps rather than running out. Six tokens, any number of places.
    slot: SLOTS[index % SLOTS.length] ?? 1,
  }));
}

/**
 * The slot a leaf is showing, or undefined when it is unassigned.
 *
 * Also undefined when the assignment names a place that is not in `bases` —
 * a place the player deleted, or one named by a hash authored on another
 * device. SPEC-0011 REQ "An Assignment Naming an Absent Place Is Unassigned"
 * makes that leaf unassigned, and an unassigned leaf carries no slot, so the
 * lookup returning nothing is the rule rather than a miss.
 */
export function slotFor(
  assignments: Readonly<Record<string, string>>,
  itemId: string,
  bases: readonly Base[],
): IdentitySlot | undefined {
  const id = assignments[itemId];
  if (id === undefined) return undefined;
  return bases.find((base) => base.id === id)?.slot;
}
