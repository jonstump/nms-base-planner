import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { ICON_ONLY_CONTROL_AUDIT } from "../helpers/accessible-name";
import { STATUSES } from "../../src/shell/StatusBadge";

/*
 * Governing: ADR-0004 (React view layer), ADR-0019 (frontend quality),
 * SPEC-0005 Accessibility Requirements
 *
 * The accessibility criterion ADR-0004 states as "tested, not assumed".
 *
 * #60 shipped the primitives with tests for the parts that were load-bearing
 * to building them: the four landmarks, the audit, the three focus-return
 * routes, and the live region's recompute-not-render distinction. Those are on
 * main and are not repeated here.
 *
 * This file covers what that left, and each of them is a case that passes
 * vacuously if written carelessly:
 *
 *   - icon-only labelling, where the standard's own definition of "named"
 *     accepts a control called "✕"
 *   - tab order against visual layout, which nothing currently checks
 *   - Space as well as Enter, where testing one and assuming the other is the
 *     whole failure mode
 *   - every colour-carried state, where testing one badge and generalising is
 *     the same mistake in a different place
 *   - composite widgets, where there are none yet, so the only honest test is
 *     one that fails when one appears without arrow keys
 */

const SHELL = "/";

async function resolveAPlan(page: Page): Promise<void> {
  await page.getByLabel("Target").fill("ANTIMATTER");
  await page.getByRole("button", { name: "Recompute" }).click();
  await expect(page.getByRole("heading", { level: 3 })).toBeVisible({ timeout: 20_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto(SHELL);
});

/* ----------------------------------------------------------------------
 * Icon-only controls
 * ------------------------------------------------------------------- */

test("no control is named only by a glyph", async ({ page }) => {
  await resolveAPlan(page);
  await page.locator(".figure-row").first().click();
  await expect(page.getByRole("dialog")).toBeVisible();

  /*
   * How many controls the audit actually looked at. Without this the
   * assertion below is satisfied by a page with no controls, or by a
   * selector list that has stopped matching anything — both of which report
   * "no unnamed controls" perfectly well.
   */
  const examined = await page.evaluate(
    () =>
      document.querySelectorAll('button, a[href], [role="button"], [role="link"]').length,
  );
  expect(examined, "the audit found no controls to examine").toBeGreaterThan(3);

  const unnamed = await page.evaluate(ICON_ONLY_CONTROL_AUDIT);
  expect(
    unnamed.map((control) => `${control.tag}: ${control.outer}`),
    "these controls have no name a person could be told",
  ).toEqual([]);
});

test("the glyph check rejects a control broken on purpose", async ({ page }) => {
  /*
   * Without this the assertion above is satisfied by a checker that returns
   * an empty array unconditionally — and it would, if the selector list or
   * the name computation ever stopped matching.
   *
   * All four planted controls are ones axe reports as *named*: axe sees text
   * content and is satisfied. That is the gap this check exists to cover. The
   * last two are the controls that should pass — one labelled, one pairing an
   * aria-hidden glyph with a word — so the checker is shown to discriminate
   * rather than to flag everything.
   */
  await page.evaluate(() => {
    const host = document.createElement("div");
    host.id = "glyph-plant";
    host.innerHTML = `
      <button type="button">✕</button>
      <button type="button"><span>→</span></button>
      <button type="button" aria-label="Dismiss">✕</button>
      <button type="button"><span aria-hidden="true">✓</span><span>Confirm</span></button>
    `;
    document.body.append(host);
  });

  /* The real audit function, not a reconstruction of it. */
  const found = await page.evaluate(ICON_ONLY_CONTROL_AUDIT);

  expect(found).toHaveLength(2);
  const flagged = found.map((control) => control.outer).join(" ");
  expect(flagged).toContain("✕");
  expect(flagged).toContain("→");
  expect(flagged, "a labelled control was flagged").not.toContain("Dismiss");
  expect(flagged, "a glyph-plus-word control was flagged").not.toContain("Confirm");
});

test("axe does not catch the glyph case, which is why the check above exists", async ({
  page,
}) => {
  /*
   * Recording the gap rather than asserting it from memory. If a future axe
   * version starts flagging glyph-named controls, this fails and the bespoke
   * check can be reconsidered — which is a better outcome than carrying a
   * redundant check forever because nobody rechecked the assumption.
   */
  await page.evaluate(() => {
    const host = document.createElement("div");
    host.id = "glyph-probe";
    host.innerHTML = `<button type="button">✕</button>`;
    document.body.append(host);
  });

  const results = await new AxeBuilder({ page })
    .include("#glyph-probe")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  expect(
    results.violations.map((v) => v.id),
    "axe now flags glyph-named controls — the bespoke check may be redundant",
  ).not.toContain("button-name");
});

/* ----------------------------------------------------------------------
 * Keyboard operation
 * ------------------------------------------------------------------- */

async function tabOrder(page: Page): Promise<{ id: string; x: number; y: number }[]> {
  const seen: { id: string; x: number; y: number }[] = [];
  for (let press = 0; press < 25; press += 1) {
    await page.keyboard.press("Tab");
    const current = await page.evaluate(() => {
      const active = document.activeElement;
      if (!active || active === document.body) return null;
      const box = active.getBoundingClientRect();
      return {
        id:
          active.id ||
          `${active.tagName.toLowerCase()}.${active.className.split(" ")[0] ?? ""}`,
        x: Math.round(box.x),
        y: Math.round(box.y),
      };
    });
    if (!current) break;
    if (seen.some((entry) => entry.id === current.id && entry.x === current.x)) break;
    seen.push(current);
  }
  return seen;
}

test("the shell's tab order follows visual layout", async ({ page }) => {
  /*
   * Scoped to the shell deliberately.
   *
   * SPEC-0006's design settles the opposite rule for the tree canvas: node
   * tab order is the payload's topological order, not the layout's, because
   * build order is more useful than reading order for a dependency graph. It
   * calls that "a deliberate divergence ... worth stating so it is not later
   * 'fixed'".
   *
   * A blanket "tab order follows visual layout" test would be exactly the
   * later fix that breaks it. This asserts the rule where it applies and says
   * where it does not.
   */
  const order = await tabOrder(page);
  expect(order.length).toBeGreaterThan(2);

  const ROW_TOLERANCE = 12;
  for (let i = 1; i < order.length; i += 1) {
    const previous = order[i - 1];
    const current = order[i];
    if (!previous || !current) continue;

    const sameRow = Math.abs(current.y - previous.y) <= ROW_TOLERANCE;
    const readingOrder = sameRow ? current.x >= previous.x : current.y > previous.y;
    expect(
      readingOrder,
      `tab moved from ${previous.id} (${String(previous.x)},${String(previous.y)}) ` +
        `to ${current.id} (${String(current.x)},${String(current.y)}), against reading order`,
    ).toBe(true);
  }
});

test("Space activates a control, not only Enter", async ({ page }) => {
  /*
   * The failure mode is testing one and assuming the other. A div with a
   * click handler and `role="button"` responds to Enter through the browser's
   * default and to Space not at all, which is the most common form of this
   * bug — and a suite that only presses Enter reports it as working.
   */
  await resolveAPlan(page);

  await page.locator(".figure-row").first().focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("dialog"), "Space did not activate the node").toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();

  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog"), "Enter did not activate the node").toBeVisible();
});

test("Escape dismisses from anywhere inside the dialog, not only from its first control", async ({
  page,
}) => {
  await resolveAPlan(page);
  await page.locator(".figure-row").first().focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();

  /* Move focus deeper before pressing Escape — a handler bound to one element
   * rather than the document would stop working here. */
  await page.keyboard.press("Tab");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("no composite widget exists without arrow-key navigation", async ({ page }) => {
  /*
   * SPEC-0005 requires arrow keys within composite widgets. The shell has no
   * composite widget yet, so a test driving arrow keys would assert nothing
   * and pass forever.
   *
   * This is the honest form: it enumerates the roles that carry an arrow-key
   * obligation and fails the moment one appears, so the requirement is
   * enforced at the point it becomes real rather than remembered later. The
   * tree canvas (SPEC-0006) and its method and recipe controls are where that
   * is expected to happen.
   */
  await resolveAPlan(page);
  await page.locator(".figure-row").first().click();
  await expect(page.getByRole("dialog")).toBeVisible();

  const COMPOSITE_ROLES = [
    "tablist",
    "menu",
    "menubar",
    "listbox",
    "tree",
    "grid",
    "radiogroup",
    "toolbar",
    "combobox",
  ];

  const present = await page.evaluate(
    (roles) =>
      roles.filter((role) => document.querySelector(`[role="${role}"]`) !== null),
    COMPOSITE_ROLES,
  );

  expect(
    present,
    "a composite widget appeared — SPEC-0005 requires arrow-key navigation within it, " +
      "so replace this guard with a test that drives the arrow keys",
  ).toEqual([]);
});

/* ----------------------------------------------------------------------
 * Colour is never the only carrier
 * ------------------------------------------------------------------- */

test("every status renders a glyph and a word, not a colour alone", async ({ page }) => {
  /*
   * Every status, rendered through the real component via the fixture.
   *
   * The shell reaches two of the five by ordinary use — the invalid-quantity
   * warning and the pending badge — so walking the running app checks two and
   * infers three. #60's test did exactly that. This mounts one badge per
   * member of the component's own table, so a status added without a second
   * carrier fails here rather than never being visited.
   */
  await page.goto("/tests/fixtures/status.html");
  await expect(page.locator("body")).toHaveAttribute(
    "data-status-count",
    String(STATUSES.length),
  );

  const badges = page.locator(".status-badge");
  await expect(badges).toHaveCount(STATUSES.length);

  for (const status of STATUSES) {
    const badge = page.locator(`[data-status="${status}"] .status-badge`);
    await expect(badge, `${status} did not render`).toBeVisible();

    await expect(badge.locator(".status-glyph"), `${status} has no glyph`).toBeVisible();

    /*
     * Two, not three. The `ok` badge reads "OK", which is the shortest label
     * in the table and a perfectly good word — the first draft of this test
     * used a threshold of three and failed on it. The threshold is calibrated
     * to the real table rather than the table trimmed to the threshold.
     */
    const text = await badge.innerText();
    expect(
      text.replace(/[^\p{L}\p{N}]/gu, "").length,
      `the ${status} badge carries no word, so colour is doing the work alone`,
    ).toBeGreaterThanOrEqual(2);
  }
});

test("each status is distinguishable without colour", async ({ page }) => {
  /*
   * The companion. Every badge having *a* word is not the requirement — the
   * requirement is that the states are told apart. Five badges all reading
   * "Status" with five different colours would pass the test above.
   */
  await page.goto("/tests/fixtures/status.html");

  /*
   * The accessible text, not innerText.
   *
   * innerText includes the glyph, so two statuses reading "Pending" with
   * different glyphs look distinct to this test and identical to a screen
   * reader — which is the population the requirement is about. The mutation
   * check caught that: relabelling `unverified` to "Pending" left this test
   * green until it started excluding aria-hidden content.
   */
  const words: string[] = [];
  for (const status of STATUSES) {
    words.push(
      await page.locator(`[data-status="${status}"] .status-badge`).evaluate((badge) => {
        const clone = badge.cloneNode(true) as Element;
        clone.querySelectorAll('[aria-hidden="true"]').forEach((hidden) => {
          hidden.remove();
        });
        return (clone.textContent ?? "").trim();
      }),
    );
  }

  expect(
    new Set(words).size,
    `two statuses are announced identically: ${words.join(" | ")}`,
  ).toBe(STATUSES.length);
});

test("the status table is exhaustive over what the component can render", async () => {
  /*
   * Guards the enumeration itself. If STATUSES stopped being derived from the
   * presentation table — say someone replaced it with a hand-written list —
   * every loop above would silently check fewer states than exist.
   */
  const { STATUSES: live } = (await import("../../src/shell/StatusBadge")) as {
    STATUSES: readonly string[];
  };
  expect([...live].sort()).toEqual(["danger", "ok", "pending", "unverified", "warning"]);
});
