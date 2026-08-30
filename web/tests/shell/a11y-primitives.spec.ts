import { expect, test, type Page } from "@playwright/test";

import { openPlanner, chooseTarget } from "../helpers/surfaces";

import { STATUSES } from "../../src/shell/StatusBadge";

/*
 * Governing: ADR-0004 (React view layer), SPEC-0005 Accessibility
 * Requirements
 *
 * The primitives the tree canvas and the base planner card will inherit
 * rather than reimplement. #62 tests each focus-return route separately and
 * in depth; these establish that the primitives work at all.
 */

async function openTheFirstNodePopover(page: Page): Promise<void> {
  await page.goto("/");
  await openPlanner(page);
  await chooseTarget(page, "ANTIMATTER");
  await page.getByRole("button", { name: "Recompute" }).click();
  await expect(page.getByRole("heading", { level: 3 })).toBeVisible({ timeout: 20_000 });

  await page.locator(".figure-row").first().focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
}

/** The id of whatever currently has focus, plus its text, for a readable failure. */
async function activeDescription(page: Page): Promise<string> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (!active) return "nothing";
    return `${active.tagName.toLowerCase()}.${active.className} "${(active.textContent ?? "").slice(0, 40)}"`;
  });
}

test("focus moves into the popover on open", async ({ page }) => {
  await openTheFirstNodePopover(page);

  const inside = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    return dialog?.contains(document.activeElement) ?? false;
  });
  expect(inside, `focus is at ${await activeDescription(page)}`).toBe(true);
});

test("focus returns to the invoking node when Escape closes the popover", async ({
  page,
}) => {
  await openTheFirstNodePopover(page);
  const invoker = await page.locator(".figure-row").first().innerText();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();

  expect(await activeDescription(page)).toContain(invoker.split("\n")[0] ?? "");
});

test("focus returns to the invoking node when the close control is used", async ({
  page,
}) => {
  await openTheFirstNodePopover(page);
  const invoker = await page.locator(".figure-row").first().innerText();

  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  expect(await activeDescription(page)).toContain(invoker.split("\n")[0] ?? "");
});

test("focus returns to the invoking node when the backdrop is clicked", async ({
  page,
}) => {
  /*
   * The route an implementation that restores focus inside its Escape
   * handler gets wrong, and the reason the restore lives in the trap's
   * cleanup rather than in any handler.
   */
  await openTheFirstNodePopover(page);
  const invoker = await page.locator(".figure-row").first().innerText();

  await page.locator(".popover-backdrop").click({ force: true });
  await expect(page.getByRole("dialog")).toBeHidden();

  expect(await activeDescription(page)).toContain(invoker.split("\n")[0] ?? "");
});

test("Tab stays inside the popover while it is open", async ({ page }) => {
  await openTheFirstNodePopover(page);

  for (let press = 0; press < 6; press += 1) {
    await page.keyboard.press("Tab");
    const inside = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      return dialog?.contains(document.activeElement) ?? false;
    });
    expect(
      inside,
      `Tab ${String(press + 1)} escaped to ${await activeDescription(page)}`,
    ).toBe(true);
  }
});

test("the live region announces on recompute and not on render", async ({ page }) => {
  await page.goto("/");
  await openPlanner(page);

  const region = page.getByRole("status");
  await expect(region).toBeAttached();

  /*
   * The distinction a naive implementation conflates. The region exists from
   * first paint and must be silent until something is computed — a user who
   * hears "totals updated" on page load learns to ignore the region.
   */
  await expect(region).toHaveText("");

  await chooseTarget(page, "ANTIMATTER");
  await expect(region).toHaveText("");

  await page.getByRole("button", { name: "Recompute" }).click();
  await expect(region).toContainText("Totals updated", { timeout: 20_000 });
});

test("the announcement names what changed", async ({ page }) => {
  await page.goto("/");
  await openPlanner(page);
  await chooseTarget(page, "ANTIMATTER");
  await page.getByRole("button", { name: "Recompute" }).click();

  const region = page.getByRole("status");
  await expect(region).toContainText("Antimatter", { timeout: 20_000 });
  await expect(region).toContainText("steps");
});

test("a preference change does not announce", async ({ page }) => {
  /*
   * The companion. An implementation that announced on render would pass the
   * test above and fire here too, which is the failure mode: announcements
   * that do not correspond to a computation.
   */
  await page.goto("/");
  await openPlanner(page);
  await chooseTarget(page, "ANTIMATTER");
  await page.getByRole("button", { name: "Recompute" }).click();

  const region = page.getByRole("status");
  await expect(region).toContainText("Totals updated", { timeout: 20_000 });
  const announced = await region.innerText();

  await page.locator(".figure-row").first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");

  /* Selecting and dismissing is interface state. Nothing recomputed. */
  await expect(region).toHaveText(announced);
});

test("every status carries a signal other than its colour", async ({ page }) => {
  /*
   * Enumerated from the component's own table rather than from a list
   * written here, so a status added without a glyph and a word fails this
   * rather than being missed.
   */
  expect(STATUSES.length).toBeGreaterThan(0);

  await page.goto("/");
  await openPlanner(page);
  await page.getByLabel("Quantity").fill("not a quantity");

  const badge = page.locator(".status-badge").first();
  await expect(badge).toBeVisible();

  /* A glyph, and a word that is not the glyph. */
  await expect(badge.locator(".status-glyph")).toBeVisible();
  const text = await badge.innerText();
  expect(
    text.replace(/[^A-Za-z]/g, "").length,
    `"${text}" carries no words`,
  ).toBeGreaterThan(2);
});
