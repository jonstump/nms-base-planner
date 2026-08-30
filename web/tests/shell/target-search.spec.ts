import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { matches, type CatalogueItem } from "../../src/boundary";
import { countCrossings, crossings } from "../helpers/crossings";
import { openPlanner } from "../helpers/surfaces";

/*
 * Governing: ADR-0004 (React view layer), ADR-0010 (places first and the
 * shell), SPEC-0011 REQ "Target Selection Is a Search Over Known Items",
 * REQ "The Catalogue Crosses the Boundary", § Rate Limiting
 *
 * The criterion this story is measured by is one sentence: "a player who
 * has never seen an item id can reach any selectable item". The control it
 * replaces was a bare input whose value went to the domain as an id, so the
 * only way to load anything was to already know a string like ULTRAPROD2.
 */

const SEARCH = { name: "Target" } as const;

async function openSearch(page: Page): Promise<void> {
  await countCrossings(page);
  await page.goto("/");
  await openPlanner(page);
  await expect(page.getByRole("combobox", SEARCH)).toBeVisible({ timeout: 30_000 });
}

/* ----------------------------------------------------------------------
 * Matching, as a pure function
 * ------------------------------------------------------------------- */

const CATALOGUE: readonly CatalogueItem[] = [
  { id: "ANTIMATTER", name: "Antimatter" },
  { id: "AM_HOUSING", name: "Antimatter Housing" },
  { id: "ULTRAPROD2", name: "Stasis Device" },
  { id: "CAVE2", name: "Cobalt" },
];

test("the search matches a display name, which is the whole point", () => {
  /*
   * The failure being fixed: a player who knows the item as "Stasis Device"
   * had no way to reach `ULTRAPROD2`.
   */
  expect(matches(CATALOGUE, "stasis").map((item) => item.id)).toEqual(["ULTRAPROD2"]);
});

test("the search still matches an id, for anyone who has one", () => {
  expect(matches(CATALOGUE, "ULTRAPROD2").map((item) => item.id)).toEqual(["ULTRAPROD2"]);
});

test("matching is partial and case-insensitive", () => {
  expect(matches(CATALOGUE, "ANTI").length).toBe(2);
  expect(matches(CATALOGUE, "anti").length).toBe(2);
  expect(matches(CATALOGUE, "  Device ").map((item) => item.id)).toEqual(["ULTRAPROD2"]);
});

test("an empty query is every item, not no items", () => {
  /*
   * A combobox that showed nothing until you typed would be the id field
   * again for anyone who does not know what to type.
   */
  expect(matches(CATALOGUE, "").length).toBe(CATALOGUE.length);
});

/* ----------------------------------------------------------------------
 * No compiled-in list
 * ------------------------------------------------------------------- */

test("no view source carries an item list of its own", () => {
  /*
   * SPEC-0011: the searchable list "MUST arrive through the module
   * boundary… and MUST NOT ship a compiled-in copy of the item list". The
   * criterion asks for this mechanically, "the way tests/card/discipline
   * .spec.ts checks for arithmetic", because a compiled-in copy is the
   * shortcut that works right up until the artifact changes and then lies.
   *
   * Real item ids, from the shipped artifact. A view file mentioning one is
   * either hard-coding the catalogue or reasoning about a specific item,
   * and both are the same mistake.
   */
  const REAL_IDS = ["ULTRAPROD2", "AM_HOUSING", "CAVE2"];

  const roots = ["shell", "canvas", "card", "state"].map((name) =>
    path.join(import.meta.dirname, "..", "..", "src", name),
  );

  let scanned = 0;
  for (const root of roots) {
    for (const file of readdirSync(root)) {
      if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
      scanned += 1;
      const code = readFileSync(path.join(root, file), "utf8").replace(
        /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
        "",
      );
      for (const id of REAL_IDS) {
        expect(code.includes(id), `${file} hard-codes the item ${id}`).toBe(false);
      }
    }
  }
  expect(scanned, "no view sources were scanned").toBeGreaterThan(10);
});

/* ----------------------------------------------------------------------
 * In the shell
 * ------------------------------------------------------------------- */

test("a player who has never seen an id can reach an item by name", async ({ page }) => {
  await openSearch(page);

  await page.getByRole("combobox", SEARCH).fill("stasis device");
  const option = page.locator('[role="option"][data-item-id="ULTRAPROD2"]');
  await expect(option, "the item was unreachable by its display name").toBeVisible();

  /* The name leads and the id follows, so what a player recognises is first. */
  await expect(option.locator(".target-result-name")).toHaveText("Stasis Device");
  await expect(option.locator(".target-result-id")).toHaveText("ULTRAPROD2");

  await option.click();
  await page.getByRole("button", { name: "Recompute" }).click();
  await expect(page.getByRole("heading", { level: 3 })).toBeVisible({ timeout: 30_000 });
});

test("typing does not cross the boundary once per keystroke", async ({ page }) => {
  /*
   * SPEC-0011 § Rate Limiting. The list cannot change while the page is
   * open, so one crossing is the right number however much is typed.
   */
  await openSearch(page);
  const before = (await crossings(page)).catalogue;
  expect(before, "the catalogue was never fetched").toBeGreaterThan(0);

  await page.getByRole("combobox", SEARCH).pressSequentially("chromatic", { delay: 20 });
  await expect(page.getByRole("option").first()).toBeVisible();

  expect(
    (await crossings(page)).catalogue,
    "the search re-fetched the catalogue while the player typed",
  ).toBe(before);
});

test("the result count is announced, and separately from the shell's announcer", async ({
  page,
}) => {
  await openSearch(page);
  const search = page.getByRole("combobox", SEARCH);

  await search.fill("chromatic");
  const count = page.locator(".target-count");
  await expect(count).toContainText(/match/i);

  const narrow = await count.innerText();
  await search.fill("chromatic metal");
  await expect(count).not.toHaveText(narrow);

  /*
   * And it is not the shell's status region. Two announcers sharing one
   * role means the search talks over the domain's recompute.
   */
  await expect(page.getByRole("status")).toHaveCount(1);
  await expect(page.getByRole("status")).not.toContainText("match");
});

test("Escape dismisses without selecting", async ({ page }) => {
  await openSearch(page);
  const search = page.getByRole("combobox", SEARCH);

  await search.fill("cobalt");
  await expect(page.getByRole("option").first()).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("option")).toHaveCount(0);
  /* Dismissed, not cleared — clearing would be a second, unasked-for effect. */
  await expect(search).toHaveValue("cobalt");
});
