import { expect, test } from "@playwright/test";

/*
 * Governing: SPEC-0007 REQ "Power Position", REQ "Deficit Is an Action,
 * Including When It Cannot Be Sized", REQ "Build Rollup Footer"
 *
 * The unsized-deficit case is the reason this file exists. A budget in
 * deficit whose `additionalGenerators` is zero reads as "nothing to show"
 * unless `fixUnsized` is read as its own signal, and an implementation that
 * misses it passes every assertion about the sized case.
 */

const FIXTURE = "/tests/fixtures/card-power.html";
const SIZED = '[data-base="Sized Deficit"]';
const UNSIZED = '[data-base="Unsized Deficit"]';
const SURPLUS = '[data-base="Surplus"]';
/* Same zero additional generators as UNSIZED, with the flag off. */
const ZERO_SIZED = '[data-base="Zero Sized"]';

test.beforeEach(async ({ page }) => {
  await page.goto(FIXTURE, { waitUntil: "load" });
});

test("generation, draw and balance are all the payload's figures", async ({ page }) => {
  const position = page.locator(`${SIZED} [data-power="position"]`);
  await expect(position).toContainText("300");
  await expect(position).toContainText("450");
  /*
   * -150 is the payload's `balance`. A card computing generation minus draw
   * would land on the same number here — which is why the discipline scan,
   * not this assertion, is what rules the subtraction out. This rules out
   * the figure being absent or reworded into a percentage.
   */
  await expect(position).toContainText("-150");
});

test("no percentage or meter proportion is rendered beside the figures", async ({
  page,
}) => {
  const position = await page.locator(`${SIZED} [data-power="position"]`).innerText();
  expect(position).not.toMatch(/%/);
  // A meter would need a proportion the payload does not report.
  await expect(page.locator(`${SIZED} progress, ${SIZED} meter`)).toHaveCount(0);
});

test("a deficit carries a symbol and the shortfall, surviving colour removal", async ({
  page,
}) => {
  const deficit = page.locator(`${SIZED} [data-power="deficit"]`);
  await expect(deficit).toBeVisible();
  await expect(deficit).toContainText("150");

  await page.addStyleTag({
    content:
      "*, *::before, *::after { color: inherit !important;" +
      " border-color: currentColor !important; background: none !important; }",
  });
  // The word and the glyph both survive; only the colour was removed.
  await expect(deficit).toContainText("Deficit");
  await expect(deficit).toContainText("150");
});

test("a sized fix is an action naming the count and the position it produces", async ({
  page,
}) => {
  const fix = page.locator(`${SIZED} [data-fix="sized"]`);
  await expect(fix).toBeVisible();
  await expect(page.locator(`${SIZED} [data-testid="fix-count"]`)).toHaveText("3");
  await expect(fix).toContainText("electromagnetic generators");
  await expect(fix).toContainText("class B");
  await expect(fix).toContainText("out of deficit");
});

test("fixUnsized shows the deficit and states the fix needs a class", async ({
  page,
}) => {
  /*
   * The state design.md warns about: deficit true, additionalGenerators
   * zero. An implementation that infers "no fix to show" from the zero
   * hides a real deficit, and this is the only case that catches it.
   */
  const deficit = page.locator(`${UNSIZED} [data-power="deficit"]`);
  await expect(deficit).toBeVisible();
  await expect(deficit).toContainText("180");

  const fix = page.locator(`${UNSIZED} [data-fix="unsized"]`);
  await expect(fix).toBeVisible();
  await expect(fix).toContainText("needs a generator class");

  // Never presented as an actionable count.
  await expect(page.locator(`${UNSIZED} [data-fix="sized"]`)).toHaveCount(0);
  await expect(page.locator(`${UNSIZED} [data-testid="fix-count"]`)).toHaveCount(0);
});

test("a solar base in deficit with no sized fix offers no panel count", async ({
  page,
}) => {
  const card = page.locator(UNSIZED);
  const fix = await card.locator('[data-fix="unsized"]').innerText();
  // No count of anything is offered as the fix.
  expect(fix).not.toMatch(/\d/);
  expect(fix).not.toMatch(/panel/i);
});

test("a surplus states the position rather than leaving it to be inferred", async ({
  page,
}) => {
  const surplus = page.locator(`${SURPLUS} [data-power="surplus"]`);
  await expect(surplus).toContainText("surplus");
  await expect(surplus).toContainText("150");
  await expect(page.locator(`${SURPLUS} [data-power="deficit"]`)).toHaveCount(0);
});

test("every footer item corresponds to a row above it", async ({ page }) => {
  const card = page.locator(SIZED);
  const rowIds = await card
    .locator("[data-row][data-item]")
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-item")));
  const froms = await card
    .locator("[data-build-item]")
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-from")));

  expect(froms.length).toBeGreaterThan(0);
  /*
   * `base` and `power` are the two legitimate non-row sources: figures the
   * domain reports per base, and generators implied by a deficit. Anything
   * else is an item the footer invented.
   */
  const invented = froms.filter(
    (from) => from !== "base" && from !== "power" && !rowIds.includes(from),
  );
  expect(invented).toEqual([]);
});

test("pending items are distinguished from unbuilt ones by a word", async ({ page }) => {
  const pending = page.locator(`${SIZED} [data-build-item][data-state="pending"]`);
  await expect(pending).toHaveCount(1);
  await expect(pending).toContainText("pending");
  await expect(pending).toContainText("Electromagnetic generators");

  // The unsized deficit has no sized fix, so it contributes no pending row.
  await expect(
    page.locator(`${UNSIZED} [data-build-item][data-state="pending"]`),
  ).toHaveCount(0);
});

test("no completion fraction is rendered anywhere", async ({ page }) => {
  for (const card of [SIZED, UNSIZED, SURPLUS]) {
    const footer = page.locator(`${card} [data-section="build-rollup"]`);
    const text = await footer.innerText();
    // "3 / 8", "38% complete", and a progress element are all the same error.
    expect(text).not.toMatch(/\d+\s*\/\s*\d+/);
    expect(text).not.toMatch(/complete/i);
    await expect(footer.locator("progress, meter")).toHaveCount(0);
  }
});

test("the same zero renders differently when the domain could size the fix", async ({
  page,
}) => {
  /*
   * #101's criterion, precisely: "Distinct from `fixUnsized: false` with the
   * same zero — the two payloads differ in one boolean and must render
   * differently."
   *
   * Without this, "fixUnsized shows the deficit and states the fix needs a
   * class" passes against a card that states it whenever the additional
   * generator count is zero, regardless of the flag. Both fixtures below are
   * in deficit with `additionalGenerators` of zero; only one has the flag.
   */
  const unsized = page.locator(UNSIZED);
  const sizedAtZero = page.locator(ZERO_SIZED);

  await expect(unsized).toBeVisible();
  await expect(sizedAtZero).toBeVisible();

  /* Both are deficits, and both say so. */
  await expect(unsized).toContainText("180");
  await expect(sizedAtZero).toContainText("180");

  /* Only the unsized one says the fix needs a class. */
  await expect(unsized).toContainText(/class/i);
  await expect(
    sizedAtZero.getByText(/needs a (generator )?class/i),
    "a fix the domain sized is being reported as unsizeable",
  ).toHaveCount(0);
});
