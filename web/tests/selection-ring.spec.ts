import { expect, test, type Locator, type Page } from "@playwright/test";

import { columnContains, describeColumn, hexToRgb, readPng } from "./helpers/pixels";
import type { PNG } from "pngjs";

/*
 * Governing: ADR-0004 (React view layer), SPEC-0005 REQ "Component Styling
 * Discipline"
 *
 * The regression this whole suite exists for.
 *
 * `inset box-shadow` is the obvious way to draw a ring inside an element, and
 * it paints into the element's background layer — beneath every positioned
 * child. A selected card with an absolutely positioned badge loses its ring
 * behind that badge. The design specifies an overlay pseudo-element instead,
 * which stacks above `auto`-stacked children.
 *
 * A test that greps for the string `inset` catches the known spelling of the
 * mistake. tests/stylesheet.spec.ts does that, and it is worth having. It
 * does not catch the mistake: any other construct that paints below a
 * positioned child fails the same way and contains no `inset`. So this test
 * renders a selected element with positioned children over the ring and asks
 * the compositor which colour won.
 *
 * Two children, because they fail differently. The `auto`-stacked one catches
 * an inset box-shadow. The `z-index: 1` one catches an overlay that lost its
 * own stacking position — with both at `auto`, DOM order puts the ::after
 * last and the ring survives anyway, which makes the missing z-index
 * invisible. scripts/mutation-check.sh is what found that gap.
 */

/** `--ok`, the selection ring colour, as the token file writes it. */
const OK = hexToRgb("#8ec07c");

const FIXTURE = "/tests/fixtures/discipline.html";

/*
 * The ring is 2px at the padding-box edge and the fixture's subject carries
 * no border, so it lands within the first few rows of the element's own
 * screenshot. Six absorbs subpixel rounding without reaching the children's
 * own fill, which starts lower down.
 */
const RING_BAND = 6;

interface Sample {
  png: PNG;
  /** x over the child that stacks at `auto`. */
  overAuto: number;
  /** x over the child that stacks at `z-index: 1`. */
  overStacked: number;
  /** x over bare card, where the ring is unobstructed. */
  clear: number;
}

/**
 * Screenshot the card and locate three columns within it.
 *
 * All three come from the live layout rather than from the fixture's numbers.
 * A hard-coded coordinate would keep passing after a change moved a child out
 * from over the ring, which is precisely the arrangement under test.
 */
async function sample(page: Page, card: Locator): Promise<Sample> {
  const cardBox = await card.boundingBox();
  const autoBox = await page.locator("#ring-badge").boundingBox();
  const stackedBox = await page.locator("#ring-stacked").boundingBox();
  if (!cardBox || !autoBox || !stackedBox) {
    throw new Error("the fixture's subjects are not laid out");
  }

  for (const [name, box] of [
    ["#ring-badge", autoBox],
    ["#ring-stacked", stackedBox],
  ] as const) {
    expect(box.y, `${name} must overlap the ring's top border`).toBeLessThan(
      cardBox.y + RING_BAND,
    );
  }

  const clear = Math.round((Math.min(autoBox.x, stackedBox.x) - cardBox.x) / 2);
  expect(
    clear,
    "the fixture needs clear card to the left of both children",
  ).toBeGreaterThan(2);

  /* The two children must not overlap, or one column samples both. */
  expect(autoBox.x + autoBox.width).toBeLessThan(stackedBox.x);

  return {
    png: readPng(await card.screenshot()),
    overAuto: Math.round(autoBox.x + autoBox.width / 2 - cardBox.x),
    overStacked: Math.round(stackedBox.x + stackedBox.width / 2 - cardBox.x),
    clear,
  };
}

function ringVisibleAt(png: PNG, x: number): boolean {
  return columnContains(png, x, 0, RING_BAND, OK);
}

test.beforeEach(async ({ page }) => {
  await page.goto(FIXTURE);
});

test("the ring paints in front of a child that stacks at auto", async ({ page }) => {
  const { png, overAuto, clear } = await sample(page, page.locator("#ring-subject"));

  expect(
    ringVisibleAt(png, clear),
    `no ring on bare card — the fixture is not selected at all: ${describeColumn(png, clear, 0, RING_BAND)}`,
  ).toBe(true);

  expect(
    ringVisibleAt(png, overAuto),
    `the ring is not visible where the auto-stacked child crosses it: ${describeColumn(png, overAuto, 0, RING_BAND)}`,
  ).toBe(true);
});

test("the ring paints in front of a child that opened its own stacking position", async ({
  page,
}) => {
  const { png, overStacked } = await sample(page, page.locator("#ring-subject"));

  expect(
    ringVisibleAt(png, overStacked),
    `the ring is not visible where the z-index: 1 child crosses it: ${describeColumn(png, overStacked, 0, RING_BAND)}`,
  ).toBe(true);
});

test("the same assertion fails against an inset box-shadow ring", async ({ page }) => {
  /*
   * The negative control, and the reason to trust the tests above.
   *
   * This swaps the overlay for the construct the requirement forbids — the
   * `inset` keyword below is deliberate, and is why it lives in a test file
   * rather than a stylesheet. If the assertions above passed for any reason
   * other than paint order, they would pass here too.
   */
  await page.addStyleTag({
    content: `
      #ring-subject::after { content: none !important; }
      #ring-subject { box-shadow: inset 0 0 0 2px var(--ok) !important; }
    `,
  });

  const { png, overAuto, overStacked, clear } = await sample(
    page,
    page.locator("#ring-subject"),
  );

  /*
   * On bare card the shadow ring is plainly visible. Asserting this first is
   * what makes the rest mean "a child covered it" rather than "the ring was
   * never drawn" — without it, deleting the rule entirely would satisfy the
   * test.
   */
  expect(
    ringVisibleAt(png, clear),
    `the inset ring was not drawn at all, so this control proves nothing: ${describeColumn(png, clear, 0, RING_BAND)}`,
  ).toBe(true);

  for (const [name, x] of [
    ["the auto-stacked child", overAuto],
    ["the z-index: 1 child", overStacked],
  ] as const) {
    expect(
      ringVisibleAt(png, x),
      `an inset box-shadow was visible over ${name}, so this test cannot tell the two constructs apart: ${describeColumn(png, x, 0, RING_BAND)}`,
    ).toBe(false);
  }
});

test("the fixture's children stack where the tests assume they do", async ({ page }) => {
  /*
   * Both assumptions the paint-order tests rest on, asserted rather than
   * trusted. If the badge acquired a z-index, the first test would compare
   * two explicit stacking positions instead of checking that the overlay
   * clears an ordinary positioned child; if the stacked child lost its
   * z-index, the second test would collapse into the first.
   */
  const zIndex = async (selector: string): Promise<string> =>
    page.locator(selector).evaluate((element) => window.getComputedStyle(element).zIndex);

  expect(await zIndex("#ring-badge")).toBe("auto");
  expect(await zIndex("#ring-stacked")).toBe("1");
});
