import { expect, test } from "@playwright/test";

/*
 * Governing: SPEC-0007 REQ "Card Composition From the Build Payload",
 * REQ "Base Identity and Selection", REQ "Producer Sections",
 * REQ "Byproducts Are Shown, Not Omitted"
 *
 * The card's acceptance criteria, each as the case that catches its own
 * violation rather than as a sample of correct behaviour. The three that
 * matter most are the ones where a wrong implementation still looks right:
 * a summed base-level count is only wrong when a base carries more than one
 * step, an absent producer group is only distinguishable from an empty one
 * when a base is missing a group, and an omitted byproduct row is invisible
 * by construction.
 */

const FIXTURE = "/tests/fixtures/card.html";

const FULL = '[data-base="Verdant Shelf"]';
const SPARSE = '[data-base="Rime Outpost"]';

test.beforeEach(async ({ page }) => {
  await page.goto(FIXTURE, { waitUntil: "load" });
});

test("all four producer groups render when the payload carries all four", async ({
  page,
}) => {
  const sections = page.locator(`${FULL} .card-section[data-section]`);
  await expect(sections).toHaveCount(5); // four producers + byproducts
  for (const kind of ["farm", "extractor", "ranch", "kitchen"]) {
    await expect(page.locator(`${FULL} [data-section="${kind}"]`)).toHaveCount(1);
  }
});

test("a group absent from the payload is absent, not empty", async ({ page }) => {
  /*
   * The sparse base carries extractors only. An implementation that rendered
   * every group unconditionally passes the test above and fails this one,
   * which is the only reason this base exists.
   */
  await expect(page.locator(`${SPARSE} [data-section="extractor"]`)).toHaveCount(1);
  for (const kind of ["farm", "ranch", "kitchen"]) {
    await expect(page.locator(`${SPARSE} [data-section="${kind}"]`)).toHaveCount(0);
  }
});

test("a base-level count is shown once, not once per row", async ({ page }) => {
  /*
   * Three kitchen steps, one nutrient processor figure. Summing per row
   * would report three times the build, and this is the case that catches
   * it: with one step, a summed figure and a base-level figure agree.
   */
  await expect(page.locator(`${FULL} [data-section="kitchen"] .card-row`)).toHaveCount(3);
  const processors = page.locator(
    `${FULL} [data-section="kitchen"] .card-section-head .card-figure`,
  );
  await expect(processors).toHaveCount(1);
  await expect(processors).toContainText("Nutrient processors");
  await expect(processors).toContainText("2");

  // And never inside a row.
  await expect(
    page.locator(`${FULL} [data-section="kitchen"] .card-row`, {
      hasText: "Nutrient processors",
    }),
  ).toHaveCount(0);
});

test("a farm row shows what to build, not the required quantity alone", async ({
  page,
}) => {
  const row = page.locator(`${FULL} [data-row="farm"]`);
  await expect(row).toContainText("Plants");
  await expect(row).toContainText("Biodomes");
  await expect(row).toContainText("Required");
});

test("a yield range shows both bounds, never the optimistic one alone", async ({
  page,
}) => {
  /*
   * The domain sized `plants` on the pessimistic bound. A card presenting 30
   * as the planning figure describes a build that does not work.
   */
  const yieldFigure = page.locator(`${FULL} [data-row="farm"] .card-figure`, {
    hasText: "Yield/plant",
  });
  await expect(yieldFigure).toContainText("20");
  await expect(yieldFigure).toContainText("30");
});

test("a byproduct-covered demand is a row, marked as needing nothing built", async ({
  page,
}) => {
  const row = page.locator(`${FULL} [data-row="no-build"]`);
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Condensed Carbon");
  await expect(row).toContainText("200");
  await expect(row).toContainText("Gas refine byproduct");
  // A word, not a colour: the distinction has to survive not seeing it.
  await expect(row).toContainText("Nothing to build");
});

test("the selection control is a real control, not a div with a tab index", async ({
  page,
}) => {
  const control = page.locator(`${FULL} .card-select`);
  await expect(control).toHaveRole("button");
  await expect(control).toHaveAttribute("aria-pressed", "true");
  // Reachable by keyboard because it is a button, not because of a tabindex.
  await expect(control).not.toHaveAttribute("tabindex", /.*/);
});

test("the card is identifiable by name with colour removed entirely", async ({
  page,
}) => {
  /*
   * SPEC-0005 forbids colour carrying a distinction alone, and SPEC-0007
   * makes the name the primary identifier. Stripping every colour in the
   * document is the only way to assert the name is doing the work.
   */
  await page.addStyleTag({
    content:
      "*, *::before, *::after { color: inherit !important;" +
      " border-color: currentColor !important; background: none !important; }",
  });
  await expect(page.locator(`${FULL} .card-name`)).toContainText("Verdant Shelf");
  await expect(page.locator(`${SPARSE} .card-name`)).toContainText("Rime Outpost");
});

test("selection leaves the identity frame intact and rings inboard", async ({ page }) => {
  const card = page.locator(FULL);
  await expect(card).toHaveAttribute("data-selected", "true");
  await expect(card).toHaveClass(/identity/);
  await expect(card).toHaveClass(/selectable/);

  const ring = await card.evaluate((el) => {
    const after = getComputedStyle(el, "::after");
    return { width: after.borderTopWidth, style: after.borderTopStyle };
  });
  expect(ring.style).toBe("solid");
  expect(ring.width).not.toBe("0px");
});

test("a base with no identity slot says so rather than inventing one", async ({
  page,
}) => {
  const card = page.locator(SPARSE);
  await expect(card).toHaveClass(/identity-unassigned/);
  // The dashed frame AND the badge. base.css: never the frame alone.
  await expect(card.locator(".status-badge")).toContainText("Unassigned");
});
