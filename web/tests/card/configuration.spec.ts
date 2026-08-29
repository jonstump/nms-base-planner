import { expect, test } from "@playwright/test";

/*
 * Governing: SPEC-0007 REQ "Site Configuration", REQ "Power Configuration
 * Supports Mixed Sources"
 *
 * The two configuration requirements, each tested at the point where a
 * plausible wrong implementation still looks right. A per-row class control
 * looks correct on a base with one extractor row; an EM-or-solar toggle looks
 * correct until a base runs both; a solar class picker looks like symmetry
 * with the EM control rather than like the computation error it is.
 */

const FIXTURE = "/tests/fixtures/card-config.html";
const CARD = '[data-base="Verdant Shelf"]';

test.beforeEach(async ({ page }) => {
  await page.goto(FIXTURE, { waitUntil: "load" });
});

test("one extractor class control governs a card with three extractor rows", async ({
  page,
}) => {
  await expect(page.locator(`${CARD} [data-row="extractor"]`)).toHaveCount(3);
  await expect(page.locator(`${CARD} [data-testid="extractor-class"]`)).toHaveCount(1);
  // And no row carries its own.
  await expect(page.locator(`${CARD} [data-row="extractor"] select`)).toHaveCount(0);
});

test("fill duration is exposed, not implied", async ({ page }) => {
  const fill = page.locator(`${CARD} [data-testid="fill-seconds"]`);
  await expect(fill).toHaveCount(1);
  await expect(fill).toHaveValue("3600");
  await expect(page.getByLabel("Fill duration (s)")).toBeVisible();
});

test("changing the extractor class issues a boundary call", async ({ page }) => {
  /*
   * The baseline is not zero: mounting computes the initial configuration,
   * which is correct and is not a configuration change. What this asserts is
   * that a change moves the count, which is the requirement — "changing
   * either MUST recompute through the boundary".
   */
  const before = Number(await page.locator("body").getAttribute("data-rollup-calls"));
  expect(before).toBeGreaterThan(0);

  await page.locator(`${CARD} [data-testid="extractor-class"]`).selectOption("S");

  await expect(page.locator("body")).toHaveAttribute("data-last-extractor-class", "S");

  /*
   * Both stages, not one. The class resizes extractor counts in stage 2 and
   * their draw in stage 3, and deciding per-field which to re-run would be
   * the view reasoning about the domain's dependency graph.
   */
  const rollupAfter = Number(
    await page.locator("body").getAttribute("data-rollup-calls"),
  );
  const powerAfter = Number(await page.locator("body").getAttribute("data-power-calls"));
  expect(rollupAfter).toBeGreaterThan(before);
  expect(powerAfter).toBeGreaterThan(0);
});

test("a base runs electromagnetic generators and solar panels together", async ({
  page,
}) => {
  /*
   * The case the prototype's toggle cannot represent, and the one most
   * likely to be lost by building from the design alone.
   */
  await page.locator(`${CARD} [data-testid="em-generators"]`).fill("4");
  await page.locator(`${CARD} [data-testid="solar-panels"]`).fill("12");

  await expect(page.locator(`${CARD} [data-testid="em-generators"]`)).toHaveValue("4");
  await expect(page.locator(`${CARD} [data-testid="solar-panels"]`)).toHaveValue("12");
  await expect(page.locator("body")).toHaveAttribute("data-last-solar-panels", "12");
  // Configuring one did not clear the other.
  await expect(page.locator(`${CARD} [data-testid="em-class"]`)).toHaveCount(1);
});

test("no class control is offered for solar, anywhere", async ({ page }) => {
  await page.locator(`${CARD} [data-testid="solar-panels"]`).fill("12");

  const selects = page.locator(`${CARD} select`);
  // Exactly two class pickers on the whole card: extractor and generator.
  await expect(selects).toHaveCount(2);
  await expect(page.locator(`${CARD} [data-testid="extractor-class"]`)).toHaveCount(1);
  await expect(page.locator(`${CARD} [data-testid="em-class"]`)).toHaveCount(1);

  const labels = await page.locator(`${CARD} label`).allTextContents();
  expect(labels.filter((text) => /solar/i.test(text) && /class/i.test(text))).toEqual([]);
});

test("configuring solar surfaces the domain's battery count", async ({ page }) => {
  await expect(page.locator(`${CARD} [data-testid="batteries"]`)).toHaveCount(0);

  await page.locator(`${CARD} [data-testid="solar-panels"]`).fill("12");

  const batteries = page.locator(`${CARD} [data-testid="batteries"]`);
  await expect(batteries).toHaveCount(1);
  /*
   * 4 is the payload's figure. 12 panels over the fixture's panelsPerBattery
   * of 3 is also 4, which is exactly why this assertion is worth stating: the
   * card must be reading the domain's answer, and the two agree here only
   * because the stub answers consistently. The discipline test is what rules
   * out the division; this rules out the number being absent.
   */
  await expect(batteries).toHaveText("4");
});

test("every control is reachable and operable by keyboard", async ({ page }) => {
  for (const testid of [
    "extractor-class",
    "fill-seconds",
    "em-generators",
    "em-class",
    "solar-panels",
  ]) {
    const control = page.locator(`${CARD} [data-testid="${testid}"]`);
    await control.focus();
    await expect(control).toBeFocused();
    // Focused because it is a real control, not because of a tabindex.
    await expect(control).not.toHaveAttribute("tabindex", /.*/);
  }
});
