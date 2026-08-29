import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { BASES, slotFor } from "../../src/canvas/bases";
import { countCrossings, crossings } from "../helpers/crossings";

/*
 * Governing: ADR-0004 (React view layer), SPEC-0006 REQ "Leaf Assignment to
 * Bases", REQ "Node Card", Accessibility Requirements → Keyboard Navigation
 *
 * Three claims, checked where each is actually observable:
 *
 *   - the assignment is operable with the keyboard alone — the application
 *   - a change recomputes through the boundary — the fixture, because
 *     `RollupRequest` needs curated constants the application has no source
 *     for, and a shell that cannot dispatch cannot demonstrate a dispatch
 *   - the canvas adjusts no figure itself — the source, since a canvas that
 *     recomputed *and* adjusted would pass both of the above
 *
 * The URL-hash round trip is #135. `Plan` carries no assignments,
 * `RollupRequest` carries them beside it, and SPEC-0002 encodes neither —
 * so there is nothing here asserting a link survives them.
 */

const CANVAS = { name: "Dependency tree" } as const;

/*
 * `exact: true` throughout the fixture, because "reassign cobalt" contains
 * "assign cobalt" and getByRole matches an accessible name by substring.
 * Without it the locator resolves to two buttons and fails strict mode,
 * which is how these three tests failed first time round.
 */
const FIXTURE = "/tests/fixtures/assignment.html";

async function resolve(page: Page, target: string): Promise<void> {
  await page.getByLabel("Target").fill(target);
  await page.getByRole("button", { name: "Recompute" }).click();
  await expect(
    page.getByRole("region", CANVAS).locator(".node-card").first(),
  ).toBeVisible({ timeout: 30_000 });
}

/** A leaf, by the payload's own terminal flag. */
async function aLeafName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const answer = window.__lastResolve;
    const parsed: unknown = typeof answer === "string" ? JSON.parse(answer) : answer;
    const nodes =
      (
        parsed as {
          data?: { graph?: { nodes?: { name?: string; terminal?: boolean }[] } };
        }
      ).data?.graph?.nodes ?? [];
    return nodes.find((node) => node.terminal === true)?.name ?? "";
  });
}

/* ----------------------------------------------------------------------
 * The slot mapping
 * ------------------------------------------------------------------- */

test("a base id maps to the slot whose colour the card draws", () => {
  const second = BASES[1];
  expect(second).toBeDefined();
  expect(slotFor({ COBALT: second?.id ?? "" }, "COBALT")).toBe(second?.slot);
});

test("an unassigned leaf has no slot, and neither does an unknown base", () => {
  /*
   * The second half matters: a base id from a link or an older session that
   * no longer maps to a slot must read as unassigned rather than as slot
   * undefined-coloured, which is how a leaf ends up with no border at all.
   */
  expect(slotFor({}, "COBALT")).toBeUndefined();
  expect(slotFor({ COBALT: "base-99" }, "COBALT")).toBeUndefined();
});

test("every base has a distinct id and a distinct slot", () => {
  expect(new Set(BASES.map((base) => base.id)).size).toBe(BASES.length);
  expect(new Set(BASES.map((base) => base.slot)).size).toBe(BASES.length);
  expect(BASES.length).toBe(6);
});

/* ----------------------------------------------------------------------
 * The canvas adjusts nothing itself
 * ------------------------------------------------------------------- */

test("no canvas source adds a boundary method or does its own arithmetic", () => {
  /*
   * "The canvas MUST NOT adjust any base's totals itself", and #88: "The
   * assignment call goes through #95's `rollup` client method. This story
   * adds no boundary method of its own."
   *
   * A behavioural test cannot separate "recomputed" from "recomputed and
   * then adjusted" — both render a changed figure.
   */
  const directory = path.join(import.meta.dirname, "..", "..", "src", "canvas");
  const files = readdirSync(directory).filter(
    (name) => name.endsWith(".ts") || name.endsWith(".tsx"),
  );
  expect(files.length).toBeGreaterThan(5);

  for (const file of files) {
    const code = readFileSync(path.join(directory, file), "utf8").replace(
      /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
      "",
    );
    expect(
      /\bNumber\s*\(|\bparseInt\s*\(|\bparseFloat\s*\(|\.\s*toFixed\s*\(/.test(code),
      `canvas/${file} converts a quantity to a number`,
    ).toBe(false);
    /* The domain's own types are past the boundary; SPEC-0006 names the reach. */
    expect(code.includes("internal/"), `canvas/${file} reaches past the boundary`).toBe(
      false,
    );
  }
});

/* ----------------------------------------------------------------------
 * The dispatch, where constants exist
 * ------------------------------------------------------------------- */

test.describe("with curated constants", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(FIXTURE, { waitUntil: "load" });
    await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  });

  test("assigning a leaf issues a rollup carrying the assignment", async ({ page }) => {
    await page.getByRole("button", { name: "assign cobalt", exact: true }).click();

    await expect
      .poll(async () => page.evaluate(() => window.__assignment.requests().length), {
        timeout: 10_000,
      })
      .toBeGreaterThan(0);

    const request = await page.evaluate(() => window.__assignment.requests().at(-1));
    expect(request?.assignments).toEqual({ COBALT: "base-2" });
    /* The plan travels with it, unchanged. */
    expect(request?.plan.target).toBe("ANTIMATTER");
  });

  test("reassigning issues another rollup with the new base", async ({ page }) => {
    await page.getByRole("button", { name: "assign cobalt", exact: true }).click();
    await expect
      .poll(async () => page.evaluate(() => window.__assignment.dispatches()), {
        timeout: 10_000,
      })
      .toBe(1);

    await page.getByRole("button", { name: "reassign cobalt", exact: true }).click();
    await expect
      .poll(async () => page.evaluate(() => window.__assignment.dispatches()), {
        timeout: 10_000,
      })
      .toBe(2);

    const request = await page.evaluate(() => window.__assignment.requests().at(-1));
    expect(request?.assignments).toEqual({ COBALT: "base-5" });
  });

  test("clearing an assignment removes the key rather than blanking it", async ({
    page,
  }) => {
    /*
     * `{ COBALT: undefined }` serialises to a field the domain has to
     * interpret, and "assigned to nothing" is not in the boundary contract.
     */
    await page.getByRole("button", { name: "assign cobalt", exact: true }).click();
    await expect
      .poll(async () => page.evaluate(() => window.__assignment.dispatches()), {
        timeout: 10_000,
      })
      .toBe(1);

    await page.getByRole("button", { name: "clear cobalt", exact: true }).click();
    await expect(page.locator("[data-assigned]")).toHaveAttribute("data-assigned", "");

    const keys = await page.evaluate(() => {
      const last = window.__assignment.requests().at(-1);
      return Object.keys(last?.assignments ?? {});
    });
    expect(keys).not.toContain("COBALT");
  });
});

/* ----------------------------------------------------------------------
 * The control, in the real application
 * ------------------------------------------------------------------- */

test.describe("in the shell", () => {
  test.beforeEach(async ({ page }) => {
    await countCrossings(page);
    await page.goto("/");
    await resolve(page, "ANTIMATTER");
  });

  test("a leaf offers a base, and a non-leaf does not", async ({ page }) => {
    const leaf = await aLeafName(page);
    expect(leaf, "no terminal in this tree").not.toBe("");

    await page
      .getByRole("region", CANVAS)
      .locator(".node-card")
      .filter({ hasText: leaf })
      .first()
      .click();
    await expect(page.getByRole("dialog").getByLabel("Gathered at")).toBeVisible();
    await page.keyboard.press("Escape");

    /*
     * A non-leaf is produced by the steps below it rather than gathered, so
     * offering the control would describe a state it cannot be in.
     */
    await page
      .getByRole("region", CANVAS)
      .locator(".node-card")
      .filter({ hasText: "Antimatter" })
      .first()
      .click();
    await expect(page.getByRole("dialog").getByLabel("Gathered at")).toHaveCount(0);
  });

  test("a leaf is assigned with the keyboard alone", async ({ page }) => {
    /*
     * SPEC-0006: "the base assignment can be changed and committed without
     * a pointing device". Driven with keys from the card onward — not by
     * calling a handler, and not by clicking the select open.
     */
    const leaf = await aLeafName(page);
    await page
      .getByRole("region", CANVAS)
      .locator(".node-card")
      .filter({ hasText: leaf })
      .first()
      .focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();

    const select = page.getByRole("dialog").getByLabel("Gathered at");
    await select.focus();
    await expect(select).toBeFocused();
    await select.selectOption("base-3");

    await expect(select).toHaveValue("base-3");
  });

  test("an assigned leaf takes its base's colour on the border", async ({ page }) => {
    const leaf = await aLeafName(page);
    const card = page
      .getByRole("region", CANVAS)
      .locator(".node-card")
      .filter({ hasText: leaf })
      .first();

    const before = await card.evaluate((el) => getComputedStyle(el).borderTopColor);
    await expect(card).toHaveAttribute("data-identity", "unassigned");

    await card.click();
    await page.getByRole("dialog").getByLabel("Gathered at").selectOption("base-3");
    await page.keyboard.press("Escape");

    await expect(card).toHaveAttribute("data-identity", "3");
    const after = await card.evaluate((el) => getComputedStyle(el).borderTopColor);
    expect(after, "the border did not take the base's colour").not.toBe(before);
  });

  test("the assignment is announced, naming the leaf and the base", async ({ page }) => {
    const leaf = await aLeafName(page);
    await page
      .getByRole("region", CANVAS)
      .locator(".node-card")
      .filter({ hasText: leaf })
      .first()
      .click();
    await page.getByRole("dialog").getByLabel("Gathered at").selectOption("base-3");

    const live = page.locator('[aria-live="polite"]');
    await expect(live).toContainText(`${leaf} assigned to Base 3`);
  });

  test("clearing an assignment is announced too, and returns the dashed frame", async ({
    page,
  }) => {
    const leaf = await aLeafName(page);
    const card = page
      .getByRole("region", CANVAS)
      .locator(".node-card")
      .filter({ hasText: leaf })
      .first();

    await card.click();
    const select = page.getByRole("dialog").getByLabel("Gathered at");
    await select.selectOption("base-3");
    await select.selectOption("");

    await expect(page.locator('[aria-live="polite"]')).toContainText(
      "no longer assigned",
    );
    await page.keyboard.press("Escape");
    await expect(card).toHaveAttribute("data-identity", "unassigned");
  });

  test("assigning does not cross the resolve boundary again", async ({ page }) => {
    /*
     * An assignment is stage 2's business. A canvas that re-resolved on one
     * would be doing stage 1's work for a change stage 1 does not see.
     */
    const before = (await crossings(page)).resolve;
    const leaf = await aLeafName(page);

    await page
      .getByRole("region", CANVAS)
      .locator(".node-card")
      .filter({ hasText: leaf })
      .first()
      .click();
    await page.getByRole("dialog").getByLabel("Gathered at").selectOption("base-3");
    await page.keyboard.press("Escape");

    expect((await crossings(page)).resolve).toBe(before);
  });
});
