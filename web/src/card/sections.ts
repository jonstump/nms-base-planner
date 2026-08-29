/*
 * Which producer sections a base's payload actually carries.
 *
 * Governing: ADR-0004 (React view layer), SPEC-0007 REQ "Producer Sections",
 * SPEC-0005 REQ "The View Computes No Domain Values"
 *
 * The order is fixed here rather than in the component so a section cannot
 * be added to the card without appearing in the table a test enumerates —
 * the same reason StatusBadge exports STATUSES. A group the payload does not
 * carry is absent from the card rather than rendered empty, which SPEC-0007
 * requires and which `present` is the whole of: an absent group and a group
 * with no rows are the same fact, and the card must not draw a heading over
 * nothing.
 *
 * Nothing here reads a quantity. Presence is a property of the row list, not
 * of any figure in it, so this module never touches a domain value.
 */

import type { BaseBuild } from "../boundary";

export type ProducerKind = "farm" | "extractor" | "ranch" | "kitchen";

/** Fixed presentation order. Exported so a test enumerates rather than samples. */
export const PRODUCER_ORDER: readonly ProducerKind[] = [
  "farm",
  "extractor",
  "ranch",
  "kitchen",
];

export const PRODUCER_HEADING: Record<ProducerKind, string> = {
  farm: "Farm",
  extractor: "Extractors",
  ranch: "Ranch",
  kitchen: "Kitchen",
};

/** The payload list backing each kind. */
function rowsFor(base: BaseBuild, kind: ProducerKind): readonly unknown[] {
  switch (kind) {
    case "farm":
      return base.farms;
    case "extractor":
      return base.extractors;
    case "ranch":
      return base.ranches;
    case "kitchen":
      return base.kitchen;
  }
}

export function isPresent(base: BaseBuild, kind: ProducerKind): boolean {
  return rowsFor(base, kind).length > 0;
}

/** The kinds this base carries, in presentation order. */
export function presentKinds(base: BaseBuild): readonly ProducerKind[] {
  return PRODUCER_ORDER.filter((kind) => isPresent(base, kind));
}
