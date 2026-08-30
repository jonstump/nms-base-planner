import { expect, test, type Page } from "@playwright/test";

import { openPlanner, chooseTarget } from "../helpers/surfaces";

/*
 * What the canvas does when it cannot draw.
 *
 * Governing: SPEC-0006 REQ "Layout Geometry Is Not a Domain Value",
 * SPEC-0005 Accessibility Requirements
 *
 * The layout engine is a lazily fetched 1.6 MB chunk, in an application
 * built to work from a local store without a network. Losing it between
 * first paint and first resolve is an ordinary state, not a theoretical
 * one, and the interesting thing about the failure is that it is silent:
 * with no placements every card takes the same fallback coordinate and the
 * whole tree renders as one pile at the origin, which reads as a rendering
 * fault rather than as something a player can act on.
 *
 * So the assertion is not "an error appears". It is that the pile does not.
 */

const CANVAS = { name: "Dependency tree" } as const;

/** Everything vite emits for elkjs, whatever it ends up naming the chunk. */
const ELK_CHUNK = "**/*elk*";

async function recompute(page: Page, target: string): Promise<void> {
  await chooseTarget(page, target);
  await page.getByRole("button", { name: "Recompute" }).click();
  /* The figure list, which does not depend on the layout engine. */
  await expect(page.getByRole("heading", { level: 3 })).toBeVisible({ timeout: 20_000 });
}

test("without its layout engine the canvas says so instead of piling the nodes up", async ({
  page,
}) => {
  await page.route(ELK_CHUNK, (route) => route.abort());
  await page.goto("/");
  await openPlanner(page);
  await recompute(page, "ANTIMATTER");

  const canvas = page.getByRole("region", CANVAS);
  await expect(canvas.locator(".layout-unavailable")).toBeVisible({ timeout: 30_000 });

  /*
   * The failure this test exists for. Before the three-state layout, an
   * engine that would not load returned an empty map, which the canvas
   * could not tell from a laid-out graph, and every node rendered at
   * (0, 0): one card's worth of pixels holding thirty-six cards.
   */
  await expect(canvas.locator(".react-flow__node")).toHaveCount(0);
});

test("the figures are unaffected, and the canvas does not claim they are wrong", async ({
  page,
}) => {
  await page.route(ELK_CHUNK, (route) => route.abort());
  await page.goto("/");
  await openPlanner(page);
  await recompute(page, "ANTIMATTER");

  const canvas = page.getByRole("region", CANVAS);
  await expect(canvas.locator(".layout-unavailable")).toBeVisible({ timeout: 30_000 });

  /*
   * One surface failed, not the plan. The figure list is computed in the
   * domain and reached the screen before the canvas asked for a layout;
   * a message that read as "the plan is broken" would be false.
   */
  await expect(page.locator(".figure-row").first()).toBeVisible();
  await expect(page.getByRole("main")).toContainText("Silver");
});

test("the message is announced, not only drawn", async ({ page }) => {
  /*
   * SPEC-0005 Accessibility Requirements: a state change a sighted player
   * learns from the screen has to reach one who does not have it. The
   * canvas region is where a tree was expected; without a live region its
   * absence is silence.
   */
  await page.route(ELK_CHUNK, (route) => route.abort());
  await page.goto("/");
  await openPlanner(page);
  await recompute(page, "ANTIMATTER");

  const message = page.getByRole("status").filter({ hasText: /could not be laid out/i });
  await expect(message).toBeVisible({ timeout: 30_000 });
});

test("with the engine available the canvas draws, so the tests above are about the failure", async ({
  page,
}) => {
  /*
   * The negative control. Every assertion above is satisfied by a canvas
   * that never draws anything, and the route interception is the only
   * thing separating the two runs — if it stopped matching the chunk, the
   * first test would pass for the wrong reason and this one would fail.
   */
  await page.goto("/");
  await openPlanner(page);
  await recompute(page, "ANTIMATTER");

  const canvas = page.getByRole("region", CANVAS);
  await expect(canvas.locator(".node-card").first()).toBeVisible({ timeout: 30_000 });
  await expect(canvas.locator(".layout-unavailable")).toHaveCount(0);

  const positions = await canvas
    .locator(".react-flow__node")
    .evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).style.transform || "(none)"),
    );

  expect(positions.length).toBeGreaterThan(1);
  expect(
    new Set(positions).size,
    "every node shares one position — the pile, with the engine available",
  ).toBe(positions.length);
});
