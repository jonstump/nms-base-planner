/*
 * The searchable item catalogue, decoded.
 *
 * Governing: ADR-0004 (React view layer), SPEC-0011 REQ "The Catalogue
 * Crosses the Boundary", REQ "Target Selection Is a Search Over Known
 * Items", SPEC-0005 REQ "Boundary Client"
 *
 * Two fields per item and no more. The view searches names and ids and
 * sends back an id; anything else here would be domain data the view is not
 * allowed to reason about.
 *
 * All-or-nothing, like every other decoder in this directory. A catalogue
 * missing one item silently is a search that cannot reach it, and "the item
 * is not in the game" and "the item fell out of the payload" look identical
 * from the search box.
 */

import { list, object, text } from "./decode";

export interface CatalogueItem {
  readonly id: string;
  /** What a player recognises. Primary in the results; the id is secondary. */
  readonly name: string;
}

function decodeItem(value: unknown): CatalogueItem | null {
  const raw = object(value);
  if (!raw) return null;

  const id = text(raw["id"]);
  const name = text(raw["name"]);
  if (id === null || name === null) return null;

  return { id, name };
}

/** Pull `data.catalogue.items` out of a result payload, or return null. */
export function selectCatalogue(data: unknown): readonly CatalogueItem[] | null {
  const payload = object(data);
  const raw = payload === null ? null : object(payload["catalogue"]);
  if (!raw) return null;
  if (!Array.isArray(raw["items"])) return null;

  return list(raw["items"], decodeItem);
}

/*
 * Matching, kept out of the component so it can be tested without a page.
 *
 * SPEC-0011: the search "MUST match against both display name and id, MUST
 * tolerate partial and inexact input". Case-folded substring over both
 * fields is the whole of it — a fuzzier ranking would be inventing an order
 * the spec does not ask for, and an exact match would be the id field this
 * requirement exists to replace.
 */
export function matches(
  items: readonly CatalogueItem[],
  query: string,
): readonly CatalogueItem[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return items;
  return items.filter(
    (item) =>
      item.name.toLowerCase().includes(needle) || item.id.toLowerCase().includes(needle),
  );
}
