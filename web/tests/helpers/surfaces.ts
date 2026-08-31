/*
 * Reaching a surface in the shell.
 *
 * Governing: SPEC-0011 REQ "The Shell Opens on Bases and Renders Without
 * the Domain", REQ "Surfaces Are Shell View State"
 *
 * The entry surface is bases, so a test that wants the plan form has to
 * switch first. This exists so that fact lives in one place: when the
 * surface set changes again, the suite follows from here rather than from
 * ten separate `goto` calls.
 */

import { expect, type Page } from "@playwright/test";

export async function openSurface(page: Page, name: string): Promise<void> {
  await page
    .getByRole("navigation", { name: "Surfaces" })
    .getByRole("button", { name, exact: true })
    .click();
  await expect(page.getByRole("region", { name, exact: true })).toBeVisible();
}

/** The surface carrying the target control, the figures and the canvas. */
export async function openPlanner(page: Page): Promise<void> {
  await openSurface(page, "Planner");
}

/*
 * Choosing a target through the search.
 *
 * Governing: SPEC-0011 REQ "Target Selection Is a Search Over Known Items"
 *
 * The control used to be a bare input, so a test could `fill` an item id and
 * be done. It is a combobox now and selection is a deliberate act — typing
 * filters, choosing commits — which is the whole point of the requirement:
 * a player who has never seen an id can still reach the item.
 *
 * Filtering by the id rather than the name because that is what the callers
 * already had, and the search matches both.
 */
export async function chooseTarget(page: Page, itemId: string): Promise<void> {
  const search = page.getByRole("combobox", { name: "Target" });
  await expect(search).toBeVisible({ timeout: 30_000 });
  await search.fill(itemId);

  /*
   * Selected by attribute, not by text. The catalogue is the real 2,237-item
   * artifact: searching "ANTIMATTER" matches five items, four of them by
   * name — "Antimatter Housing", "Antimatter Observation Orb" and two
   * trails. A `hasText` filter takes whichever comes first in artifact
   * order, which is `AM_HOUSING`, so the tree resolved for the wrong item
   * and every assertion after it looked for nodes that were never coming.
   */
  const option = page.locator(`[role="option"][data-item-id="${itemId}"]`);
  await expect(option, `no catalogue item has id ${itemId}`).toBeVisible({
    timeout: 30_000,
  });
  await option.click();

  /* And it took. A silent miss here is a wrong tree three assertions later. */
  await expect(search).not.toHaveValue("");
}
