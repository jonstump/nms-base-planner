import { readFileSync } from "node:fs";
import path from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { SURFACES } from "../../src/shell/surfaces";
import { openSurface } from "../helpers/surfaces";

/*
 * Governing: ADR-0010 (places first and the shell), SPEC-0011 REQ "The
 * Shell Opens on Bases and Renders Without the Domain", REQ "Surfaces Are
 * Shell View State", Accessibility Requirements → ARIA Landmarks, Focus
 * Management
 *
 * The claim with the most in it is the entry one. SPEC-0005 already loads
 * the module lazily, so the shell *can* be interactive before it arrives —
 * what SPEC-0011 adds is that the entry surface must be complete rather
 * than merely present, "with no error and no loading state standing in for
 * its content". A spinner on entry fails the requirement even though the
 * page is technically interactive.
 */

/** The binary, blocked so the module never arrives. */
const WASM = "**/planner.wasm";

async function withoutModule(page: Page): Promise<void> {
  await page.route(WASM, (route) => route.abort());
}

/* ----------------------------------------------------------------------
 * Entry
 * ------------------------------------------------------------------- */

test("the shell opens on bases", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Bases", exact: true })).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Surfaces" }).getByRole("button", {
      name: "Bases",
      exact: true,
    }),
  ).toHaveAttribute("aria-current", "page");
});

test("entry with no module is complete, interactive, and not an error", async ({
  page,
}) => {
  /*
   * The acceptance criterion is blunt about the failure mode: "A spinner on
   * entry fails this." So this asserts the content is there *and* that no
   * pending or error treatment is standing in for it.
   */
  await withoutModule(page);
  await page.goto("/");

  const bases = page.getByRole("region", { name: "Bases", exact: true });
  await expect(bases).toBeVisible();

  /* Its own controls work with the module never having arrived. */
  await expect(bases.getByRole("region", { name: "Saved places" })).toBeVisible();
  await expect(bases.getByRole("region", { name: "Your data" })).toBeVisible();
  await expect(bases.getByLabel("Group digits")).toBeEnabled();

  /* No loading state in place of content, and no error about the module. */
  await expect(bases.getByText(/Pending/i)).toHaveCount(0);
  await expect(bases.getByText(/could not|failed|unavailable|error/i)).toHaveCount(0);
});

test("entry with an empty workspace invites a place rather than showing zeroes", async ({
  page,
}) => {
  await withoutModule(page);
  await page.goto("/");

  const saved = page.getByRole("region", { name: "Saved places" });
  await expect(saved).toBeVisible();
  await expect(saved.getByText(/nothing saved|no places|add a place/i)).toBeVisible();

  /*
   * Not a screen of zeroes. A count of 0 places is a true statement and the
   * wrong thing to show someone who has never used the application.
   */
  await expect(saved.getByText(/^0$/)).toHaveCount(0);
});

/* ----------------------------------------------------------------------
 * The switcher
 * ------------------------------------------------------------------- */

test("exactly one named navigation landmark exists on every surface", async ({
  page,
}) => {
  await page.goto("/");

  for (const surface of SURFACES) {
    await openSurface(page, surface.label);
    await expect(
      page.getByRole("navigation"),
      `${surface.label} has more than one navigation landmark`,
    ).toHaveCount(1);
    await expect(page.getByRole("navigation")).toHaveAttribute("aria-label", "Surfaces");
  }
});

test("the switcher lists every surface with the module unavailable", async ({ page }) => {
  /*
   * SPEC-0011: "a surface whose data is unavailable MUST present its own
   * empty or loading state rather than being absent from the switcher, so
   * the set of surfaces does not change under the player." A switcher that
   * shrank while the binary downloaded would move controls under someone's
   * cursor mid-click.
   */
  await withoutModule(page);
  await page.goto("/");

  const nav = page.getByRole("navigation", { name: "Surfaces" });
  await expect(nav.getByRole("button")).toHaveCount(SURFACES.length);

  for (const surface of SURFACES) {
    await expect(
      nav.getByRole("button", { name: surface.label, exact: true }),
      `${surface.label} vanished from the switcher`,
    ).toBeVisible();
  }
});

test("a surface that needs the module presents its own state rather than disappearing", async ({
  page,
}) => {
  await withoutModule(page);
  await page.goto("/");
  await openSurface(page, "Planner");

  const planner = page.getByRole("region", { name: "Planner", exact: true });
  await expect(planner).toBeVisible();
  /* Its own controls are there; it is the figures that have nothing yet. */
  await expect(planner.getByLabel("Target")).toBeVisible();
});

test("no router package is installed", () => {
  /*
   * SPEC-0011: "The application MUST NOT introduce a router library."
   * Checked against the manifest rather than by grepping imports — a router
   * added and not yet imported is still a router in the tree.
   */
  const manifest = JSON.parse(
    readFileSync(path.join(import.meta.dirname, "..", "..", "package.json"), "utf8"),
  ) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  const installed = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ];
  expect(installed.length, "the manifest was not read").toBeGreaterThan(0);

  for (const name of installed) {
    expect(/router|wouter|\breach\b/i.test(name), `${name} is a router`).toBe(false);
  }
});

/* ----------------------------------------------------------------------
 * Focus
 * ------------------------------------------------------------------- */

test("switching surface moves focus into the new surface, not the switcher or the body", async ({
  page,
}) => {
  /*
   * SPEC-0011 Focus Management. Both halves matter: leaving focus on the
   * switcher means a keyboard user tabs from the top of the page again, and
   * dropping it to the body loses their place entirely.
   */
  await page.goto("/");

  await page
    .getByRole("navigation", { name: "Surfaces" })
    .getByRole("button", { name: "Planner", exact: true })
    .press("Enter");

  await expect(page.getByRole("region", { name: "Planner", exact: true })).toBeFocused();

  const active = await page.evaluate(() => document.activeElement?.tagName ?? "");
  expect(active, "focus fell to the body").not.toBe("BODY");
});

test("entry does not steal focus", async ({ page }) => {
  /*
   * The companion to the test above. The requirement is about a *change*,
   * and moving focus into the page on load is the behaviour that reads as a
   * page jumping out from under someone.
   */
  await page.goto("/");
  const active = await page.evaluate(
    () => document.activeElement?.getAttribute("aria-label") ?? "",
  );
  expect(active).not.toBe("Bases");
});

/* ----------------------------------------------------------------------
 * Accessibility over the whole switcher
 * ------------------------------------------------------------------- */

test("every surface passes a WCAG 2.1 AA audit", async ({ page }) => {
  await page.goto("/");

  for (const surface of SURFACES) {
    await openSurface(page, surface.label);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(
      results.violations.map((violation) => `${surface.label}: ${violation.id}`),
    ).toEqual([]);
  }
});
