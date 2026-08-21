import { expect, test, type Page } from "@playwright/test";

/*
 * Governing: ADR-0004 (React view layer), SPEC-0005 REQ "Component Styling
 * Discipline"
 *
 * The three states, asserted as the browser resolved them.
 *
 * Each was chosen to avoid a specific defect rather than for appearance, so
 * each assertion checks the mechanism and not just the effect: hover must be
 * a filter, focus must be an outline, and selection must be an overlay
 * element. A border that turned green would look selected and would be wrong,
 * because the border carries base identity and nothing else may write to it.
 */

/*
 * #8ec07c — `--ok`, the focus and selection colour, written out rather than
 * read from the token file.
 *
 * Deriving the expected value from the thing under test would assert nothing:
 * a stylesheet that set the focus ring to the wrong token would still match
 * itself. The literal is the point, and it is why scripts/check-tokens.sh
 * scans src/ rather than the whole project.
 */
const OK = "rgb(142, 192, 124)";

const FIXTURE = "/tests/fixtures/discipline.html";

interface Styles {
  [property: string]: string;
}

async function computed(page: Page, selector: string, pseudo = ""): Promise<Styles> {
  return page.evaluate(
    ({ sel, pseudoElement }: { sel: string; pseudoElement: string }) => {
      const element = document.querySelector(sel);
      if (!element) throw new Error(`no element matched ${sel}`);
      const style = window.getComputedStyle(element, pseudoElement || undefined);
      const out: Record<string, string> = {};
      for (const property of style) {
        out[property] = style.getPropertyValue(property);
      }
      return out;
    },
    { sel: selector, pseudoElement: pseudo },
  );
}

/**
 * Move keyboard focus to `id` by tabbing.
 *
 * `element.focus()` does not reliably match `:focus-visible` in Chromium —
 * the pseudo-class is about how focus arrived, and the rule under test is
 * `:focus-visible` precisely so a mouse click does not draw a ring. Tabbing
 * is the interaction the rule is written for.
 */
async function tabTo(page: Page, id: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await page.keyboard.press("Tab");
    const active = await page.evaluate(() => document.activeElement?.id ?? "");
    if (active === id) return;
  }
  throw new Error(`tabbing never reached #${id}`);
}

test.beforeEach(async ({ page }) => {
  await page.goto(FIXTURE);
});

test("hover is a filter, and leaves the identity border alone", async ({ page }) => {
  const before = await computed(page, "#hover-subject");
  expect(before["filter"]).toBe("none");

  await page.locator("#hover-subject").hover();
  const after = await computed(page, "#hover-subject");

  expect(after["filter"]).toBe("brightness(1.12)");
  expect(after["border-top-color"]).toBe(before["border-top-color"]);
  expect(after["border-top-width"]).toBe(before["border-top-width"]);
});

test("focus is an outboard outline, not a border and not a shadow", async ({ page }) => {
  const before = await computed(page, "#focus-subject");

  await tabTo(page, "focus-subject");
  const after = await computed(page, "#focus-subject");

  expect(after["outline-style"]).toBe("solid");
  expect(after["outline-width"]).toBe("2px");
  expect(after["outline-color"]).toBe(OK);

  /*
   * Outboard is the whole reason for an outline. A zero or negative offset
   * would put the ring on the border box, where it would sit over the
   * identity frame it is supposed to leave visible.
   */
  expect(Number.parseFloat(after["outline-offset"] ?? "0")).toBeGreaterThan(0);

  expect(after["box-shadow"]).toBe("none");
  expect(after["border-top-color"]).toBe(before["border-top-color"]);
});

test("selection is an overlay element with its own stacking position", async ({
  page,
}) => {
  const ring = await computed(page, "#selection-subject", "::after");

  expect(ring["content"]).not.toBe("none");
  expect(ring["position"]).toBe("absolute");
  expect(ring["border-top-width"]).toBe("2px");
  expect(ring["border-top-color"]).toBe(OK);

  /*
   * The two properties that make it an overlay rather than decoration: a
   * stacking position above `auto`-stacked children, and no pointer surface
   * so it never swallows a click meant for the content beneath it.
   */
  expect(Number.parseInt(ring["z-index"] ?? "0", 10)).toBeGreaterThan(0);
  expect(ring["pointer-events"]).toBe("none");
});

test("selection writes to no border and no shadow on the element itself", async ({
  page,
}) => {
  const selected = await computed(page, "#selection-subject");
  const unselected = await computed(page, "#unselected-subject");

  expect(selected["box-shadow"]).toBe("none");
  expect(selected["border-top-color"]).toBe(unselected["border-top-color"]);
  expect(selected["border-top-width"]).toBe(unselected["border-top-width"]);
});

test("an unselected element has no ring at all", async ({ page }) => {
  const ring = await computed(page, "#unselected-subject", "::after");
  expect(ring["content"]).toBe("none");
});
