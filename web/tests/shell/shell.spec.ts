import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { openPlanner, chooseTarget } from "../helpers/surfaces";

/*
 * Governing: ADR-0004 (React view layer), SPEC-0005 Accessibility
 * Requirements
 *
 * The shell itself, at "/" — the real application, not a fixture. #61's
 * suite has its own fixture because it tests stylesheets; this tests the
 * page a user gets.
 */

async function resolveAPlan(page: Page, target = "ANTIMATTER"): Promise<void> {
  await chooseTarget(page, target);
  await page.getByRole("button", { name: "Recompute" }).click();
  await expect(page.getByRole("heading", { level: 3 })).toBeVisible({ timeout: 20_000 });

  /*
   * And the canvas, which is the rest of the populated state.
   *
   * The figure list is behind the WASM module; the canvas is behind a lazy
   * chunk and then a layout, so it arrives later than the heading and the
   * audit below would otherwise analyse a document the canvas is not in
   * yet. That is not a slow test made fast — it is an audit of the wrong
   * page: React Flow's attribution link fails WCAG AA against this surface
   * and is restyled in canvas.css, and with this wait removed the audit
   * passes with the restyle removed too.
   *
   * Waiting here rather than in the audit so that every test built on the
   * populated state gets the whole of it.
   */
  await expect(
    page.getByRole("region", { name: "Dependency tree" }).locator(".node-card").first(),
  ).toBeVisible({ timeout: 30_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await openPlanner(page);
});

test("all four landmarks are present, once each", async ({ page }) => {
  /*
   * Once each is the assertion that matters. A second <main>, or a second
   * <nav> without a distinguishing label, makes a landmark list ambiguous —
   * a user navigating by landmark arrives somewhere and cannot tell where.
   */
  await expect(page.getByRole("banner")).toHaveCount(1);
  await expect(page.getByRole("navigation")).toHaveCount(1);
  await expect(page.getByRole("main")).toHaveCount(1);
  await expect(page.getByRole("contentinfo")).toHaveCount(1);
});

test("the navigation landmark is named", async ({ page }) => {
  /* An unnamed nav is indistinguishable from any other nav added later. */
  await expect(page.getByRole("navigation", { name: "Surfaces" })).toHaveCount(1);
});

test("the shell passes a WCAG 2.1 AA audit before any figures exist", async ({
  page,
}) => {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  expect(
    results.violations.map((violation) => `${violation.id}: ${violation.help}`),
    "axe found WCAG 2.1 AA violations",
  ).toEqual([]);
});

test("the shell passes a WCAG 2.1 AA audit with figures on screen", async ({ page }) => {
  /*
   * The empty state and the populated state are different documents. Auditing
   * only the first is auditing the screen nobody spends time on.
   */
  await resolveAPlan(page);

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  expect(
    results.violations.map((violation) => `${violation.id}: ${violation.help}`),
  ).toEqual([]);
});

test("nothing is shown as zero while the module loads", async ({ page }) => {
  /*
   * SPEC-0005 REQ "Module Loading": "figures dependent on it are shown as
   * pending, not as zero". A zero is a claim about the plan; a pending is a
   * claim about the module, and only one of them is true here.
   *
   * The observation point moved with SPEC-0011. This used to hold the binary
   * for a second, type an item id into a bare input and assert the figures
   * read "Pending" — but target selection is a search over the catalogue
   * now, and the catalogue comes from the module, so there is no longer a
   * window in which a plan can be submitted while the module is still
   * loading. That window is not missing coverage; it is unreachable.
   *
   * What is still reachable, and is the requirement's actual content, is
   * that nothing fabricates a figure while the module is on its way. So the
   * binary is still held, and the assertions are that the surface says it is
   * waiting and that no zero appears anywhere on it.
   */
  await page.route("**/planner.wasm", async (route) => {
    await new Promise((resume) => setTimeout(resume, 1000));
    await route.continue();
  });
  await page.goto("/");
  await openPlanner(page);

  const main = page.getByRole("main");

  /* Waiting, and saying so. */
  await expect(main.getByText(/Pending/i).first()).toBeVisible();

  /*
   * And no fabricated figure anywhere while it waits — not in the figures
   * region, not on a card, nowhere.
   */
  await expect(main.getByText(/^0$/)).toHaveCount(0);

  /* And it resolves, so "pending forever" cannot pass this either. */
  await chooseTarget(page, "ANTIMATTER");
  await page.getByRole("button", { name: "Recompute" }).click();
  await expect(page.getByRole("heading", { level: 3 })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByLabel("Figures")).not.toContainText("Pending");
});

test("changing an input takes the stale figures away rather than adjusting them", async ({
  page,
}) => {
  await resolveAPlan(page);
  const before = await page.getByRole("main").innerText();
  expect(before).toContain("Silver");

  await page.getByLabel("Quantity").fill("2");

  /*
   * The figures do not update to describe the new quantity, and they do not
   * stay describing the old one either. They go, because they answer a
   * question that is no longer being asked.
   */
  await expect(page.getByRole("main")).toContainText("Enter a target and recompute.");
});
