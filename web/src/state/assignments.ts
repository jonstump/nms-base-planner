/*
 * An assignment naming a place that is not there.
 *
 * Governing: ADR-0010 (a deleted place unassigns; it does not cascade and
 * does not dangle), SPEC-0011 REQ "An Assignment Naming an Absent Place Is
 * Unassigned"
 *
 *   "Where a plan carries an assignment whose `BaseID` matches no place in
 *   the workspace, the leaf MUST be treated as unassigned and MUST be
 *   presented as such ... This rule MUST hold for every source of an
 *   assignment, including one decoded from a URL hash authored on another
 *   player's device."
 *
 * One function rather than a check at each source, because "every source" is
 * the requirement and a rule applied per caller is a rule a later caller
 * forgets. The two sources today are a place the player deleted and a hash
 * from another device; they are the same shape and get the same answer.
 *
 * It lives in state/ rather than canvas/ because it is a rule about plan
 * state and the workspace, not about drawing: the canvas source is scanned
 * for comparators (SPEC-0006 REQ "Graph Rendering From the Boundary
 * Payload" — the canvas must not order nodes itself), and the sort below is
 * over item ids for an announcement rather than over anything rendered. A
 * blunt scan is the right kind of scan, so the file moved instead.
 *
 * What this deliberately does NOT do is delete anything. The plan keeps its
 * shape and the store keeps its records; the leaf is *presented* unassigned,
 * which is what makes deleting a place survivable rather than destructive.
 */

/** Assignments filtered to the places that exist, and the leaves that lost one. */
export interface ResolvedAssignments {
  readonly assignments: Readonly<Record<string, string>>;
  /**
   * Item ids whose assignment named an absent place.
   *
   * Reported rather than merely dropped: the leaf is unassigned now and the
   * player is entitled to know it moved, which is the difference between
   * this rule and silently losing the assignment.
   */
  readonly unresolved: readonly string[];
}

export function resolveAssignments(
  assignments: Readonly<Record<string, string>>,
  known: Iterable<string>,
): ResolvedAssignments {
  const exists = new Set(known);
  const kept: Record<string, string> = {};
  const unresolved: string[] = [];

  for (const [itemId, baseId] of Object.entries(assignments)) {
    if (exists.has(baseId)) {
      kept[itemId] = baseId;
    } else {
      unresolved.push(itemId);
    }
  }

  /*
   * Sorted so the same workspace and the same plan describe the same set in
   * the same order however the map was built — an announcement whose wording
   * depends on insertion order is a different message for the same state.
   */
  unresolved.sort();
  return { assignments: kept, unresolved };
}
