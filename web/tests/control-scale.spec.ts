import { expect, test, type Page } from "@playwright/test";

/*
 * Governing: ADR-0004 (React view layer), SPEC-0005 REQ "Component Styling
 * Discipline"
 *
 * One control scale, two steps, and a row never mixes them.
 *
 * Heights are read from the laid-out box rather than from the custom
 * property, because the requirement is about what a control ends up being.
 * `--control-height: 40px` can be correct while a padding or border change
 * makes the rendered control 42, and the token file's own arithmetic
 * (40 = 10 + 10 + 18 + 2) is a claim about the box, not about the variable.
 */

const FIXTURE = "/tests/fixtures/discipline.html";

const DEFAULT_STEP = 40;
const SMALL_STEP = 30;

/** SPEC-0005: coarse pointers get at least this, per WCAG 2.1 AA target size. */
const COARSE_TARGET = 44;

async function heightsIn(page: Page, row: string): Promise<number[]> {
  return page.evaluate((selector) => {
    const controls = document.querySelectorAll(`${selector} .control`);
    if (controls.length === 0) throw new Error(`no controls inside ${selector}`);
    return Array.from(controls, (control) => control.getBoundingClientRect().height);
  }, row);
}

test.beforeEach(async ({ page }) => {
  await page.goto(FIXTURE);
});

test("the default row resolves every control to the 40px step", async ({ page }) => {
  const heights = await heightsIn(page, "#row-default");
  expect(heights).toEqual(heights.map(() => DEFAULT_STEP));
});

test("the small row resolves every control to the 30px step", async ({ page }) => {
  const heights = await heightsIn(page, "#row-small");
  expect(heights).toEqual(heights.map(() => SMALL_STEP));
});

test("no row mixes the two steps", async ({ page }) => {
  /*
   * The requirement is not "40 exists and 30 exists" — it is that a row is
   * uniform. Asserting the distinct count catches a control that opted into
   * the other step, which per-control assertions against a known number
   * cannot: they would need to already know which step to expect.
   */
  for (const row of ["#row-default", "#row-small"]) {
    const distinct = new Set(await heightsIn(page, row));
    expect(
      distinct.size,
      `${row} mixes control heights: ${[...distinct].join(", ")}`,
    ).toBe(1);
  }
});

test("the two steps are actually different", async ({ page }) => {
  const [defaultHeight] = await heightsIn(page, "#row-default");
  const [smallHeight] = await heightsIn(page, "#row-small");
  expect(defaultHeight).not.toBe(smallHeight);
});

test("a fine pointer does not grow controls", async ({ page }) => {
  /*
   * The companion to the coarse-pointer test below. Without it, a stylesheet
   * that applied the coarse target unconditionally would pass every assertion
   * there while silently discarding the small step on every desktop.
   */
  const heights = [...(await heightsIn(page, "#row-small"))];
  expect(Math.max(...heights)).toBe(SMALL_STEP);
});

/*
 * `hasTouch` is what makes Chromium report `pointer: coarse`, and it is set
 * at the browser context rather than on the page — which is why this is a
 * describe block with its own `use` and not a line inside a test.
 *
 * The obvious alternative does not work and does not say so. CDP's
 * `Emulation.setEmulatedMedia` accepts `{ name: "pointer", value: "coarse" }`
 * without complaint and then ignores it: the media query still evaluates
 * false and the controls stay at their fine-pointer height. A test built on
 * it fails looking like a stylesheet bug.
 */
test.describe("under a coarse primary pointer", () => {
  test.use({ hasTouch: true });

  test("the media query matches, so the assertion below is about the stylesheet", async ({
    page,
  }) => {
    const coarse = await page.evaluate(
      () => window.matchMedia("(pointer: coarse)").matches,
    );
    expect(coarse, "the emulation did not take, so nothing below is being tested").toBe(
      true,
    );
  });

  test("every control grows to at least 44px", async ({ page }) => {
    for (const row of ["#row-default", "#row-small"]) {
      for (const height of await heightsIn(page, row)) {
        expect(height, `${row} under a coarse pointer`).toBeGreaterThanOrEqual(
          COARSE_TARGET,
        );
      }
    }
  });
});
