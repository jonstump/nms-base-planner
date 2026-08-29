/*
 * Everything to construct at one base, collected from the rows above it.
 *
 * Governing: ADR-0004 (React view layer), SPEC-0007 REQ "Build Rollup
 * Footer", SPEC-0005 REQ "The View Computes No Domain Values"
 *
 * "A rollup of everything to be constructed at that base, drawn from the
 * same payload as the sections above it" — so this collects rather than
 * computes. Every item carries `from`, the id of the row it came out of, and
 * the footer test walks those back to the rendered rows: an item whose `from`
 * matches no row is an item the footer invented, which the requirement
 * forbids and which no amount of reading the footer would reveal.
 *
 * Two `from` values are not row ids and say so. `base` marks the figures the
 * domain reports per base rather than per row — nutrient processors and
 * pellet feeders — which is the same distinction the card's sections draw
 * when they render those counts once. `power` marks generators implied by an
 * unresolved deficit, which are pending rather than unbuilt and are the one
 * kind of item with no producer row behind them.
 *
 * There is no count of built versus total here, and no field one could be
 * put in. That is REQ "Build Rollup Footer" holding: a completion fraction
 * needs durable per-base state this project does not have, and one computed
 * against session state would be a figure the card made up.
 */

import type { BaseBuild, Quantity } from "../boundary";

/** Pending items wait on a decision; unbuilt ones only wait on the player. */
export type BuildState = "unbuilt" | "pending";

export interface BuildItem {
  readonly label: string;
  readonly count: Quantity;
  /** The row id this came from, or `base` / `power`. */
  readonly from: string;
  readonly state: BuildState;
}

export interface PendingGenerators {
  readonly count: Quantity;
  readonly unitType: string;
}

export function buildItems(
  base: BaseBuild,
  pending?: PendingGenerators,
): readonly BuildItem[] {
  const items: BuildItem[] = [];

  for (const row of base.farms) {
    items.push({
      label: `${row.name} plants`,
      count: row.plants,
      from: row.itemId,
      state: "unbuilt",
    });
    items.push({
      label: `${row.name} biodomes`,
      count: row.biodomes,
      from: row.itemId,
      state: "unbuilt",
    });
  }

  for (const row of base.extractors) {
    items.push({
      label: `${row.name} extractors`,
      count: row.extractorCount,
      from: row.itemId,
      state: "unbuilt",
    });
    items.push({
      label: `${row.name} depots`,
      count: row.depots,
      from: row.itemId,
      state: "unbuilt",
    });
  }

  for (const row of base.ranches) {
    items.push({
      label: `${row.name} fauna`,
      count: row.fauna,
      from: row.itemId,
      state: "unbuilt",
    });
  }

  /*
   * Base-level, and appended once rather than per row for the same reason
   * the kitchen section renders the count once: a base with three steps has
   * one processor count, and a per-row push would report three times the
   * build in the footer while the section above it read correctly.
   */
  if (base.kitchen.length > 0) {
    items.push({
      label: "Nutrient processors",
      count: base.nutrientProcessors,
      from: "base",
      state: "unbuilt",
    });
  }
  if (base.ranches.length > 0) {
    items.push({
      label: "Pellet feeders",
      count: base.pelletFeeders,
      from: "base",
      state: "unbuilt",
    });
  }

  if (pending !== undefined) {
    items.push({
      label: pending.unitType,
      count: pending.count,
      from: "power",
      state: "pending",
    });
  }

  return items;
}
