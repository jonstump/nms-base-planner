/*
 * Absent is not zero.
 *
 * Governing: ADR-0008 (durable user data), SPEC-0009 REQ "An Empty Store Is
 * a Designed State"
 *
 * "A consumer MUST distinguish 'nothing stored' from 'stored as zero', and
 * MUST NOT render a figure the player never entered."
 *
 * This lives here, once, rather than in each surface that will need it.
 * SPEC-0009's criterion is explicit that the contract be "expressed where
 * later consumers inherit it, rather than reimplemented per surface" — and
 * the reason is that the per-surface version is always written the same
 * wrong way. `place.stocked?.[itemId] ?? 0` reads as a careful default and
 * is the exact defect: it renders a stock level of zero for an item the
 * player has never once looked at, and zero is a claim.
 *
 * The same argument SPEC-0005 makes about pending figures during module
 * load, at the other end of the lifecycle. There the rule is "pending,
 * never zero"; here it is "absent, never zero". Both exist because a
 * plausible number is worse than no number: a player can act on it.
 */

import type { PlaceRecord } from "./schema";

/**
 * A value that may not have been stored.
 *
 * A discriminated union rather than `T | undefined`, so a consumer cannot
 * reach the value without saying which case it is in. `?? 0` does not
 * typecheck against this, which is the whole point.
 */
export type Stored<T> =
  { readonly present: true; readonly value: T } | { readonly present: false };

/** Nothing was stored. Not a failure — see SPEC-0009 on the empty store. */
export const ABSENT: Stored<never> = Object.freeze({ present: false });

export function present<T>(value: T): Stored<T> {
  return { present: true, value };
}

/**
 * A stocked quantity, as an exact string.
 *
 * Never parsed and never defaulted. SPEC-0005 REQ "The View Computes No
 * Domain Values" keeps quantities as exact strings end to end, and the
 * store is the most durable point in that chain: a quantity coerced here
 * would be wrong in storage rather than wrong on screen.
 */
export function storedQuantity(place: PlaceRecord, itemId: string): Stored<string> {
  const value = place.stocked?.[itemId];
  return typeof value === "string" ? present(value) : ABSENT;
}

/**
 * Whether a construction item is ticked.
 *
 * Three states, not two. An unticked part and a part the player has never
 * seen are different, and a checklist that renders both as unchecked has
 * quietly answered a question nobody asked it.
 */
export function storedTick(place: PlaceRecord, partId: string): Stored<boolean> {
  const value = place.ticks?.[partId];
  return typeof value === "boolean" ? present(value) : ABSENT;
}

/**
 * What a surface shows in place of a value that was never entered.
 *
 * An em dash, and deliberately not "0" or "". Exported so every surface
 * shows the same thing — a reader who learns what it means on the stock
 * list should not have to learn it again on the checklist.
 */
export const ABSENT_DISPLAY = "—";

/**
 * What a screen reader is told instead.
 *
 * "—" announces as nothing at all in most screen readers, so a row using it
 * would read as a label followed by silence, which is indistinguishable
 * from a broken cell.
 */
export const ABSENT_LABEL = "not recorded";
