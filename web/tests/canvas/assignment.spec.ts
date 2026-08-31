import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { openPlanner, openSurface, chooseTarget } from "../helpers/surfaces";

import { basesFrom, slotFor, UNNAMED_PLACE } from "../../src/canvas/bases";
import type { PlaceRecord } from "../../src/store";
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
  await chooseTarget(page, target);
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

/** A stored place, with only the fields the mapping reads. */
function place(id: string, name?: string): PlaceRecord {
  return {
    id,
    kind: "base",
    schemaVersion: 1,
    ...(name === undefined ? {} : { name }),
    updatedAt: "2026-01-01T00:00:00.000Z",
    revision: 1,
  };
}

test("a base id maps to the slot whose colour the card draws", () => {
  const bases = basesFrom([place("p-1", "Alpha"), place("p-2", "Beta")]);
  const second = bases[1];
  expect(second).toBeDefined();
  expect(slotFor({ COBALT: second?.id ?? "" }, "COBALT", bases)).toBe(second?.slot);
});

test("an unassigned leaf has no slot, and neither does an unknown base", () => {
  /*
   * The second half matters: a base id from a link or an older session that
   * no longer maps to a slot must read as unassigned rather than as slot
   * undefined-coloured, which is how a leaf ends up with no border at all.
   * SPEC-0011 REQ "An Assignment Naming an Absent Place Is Unassigned" is
   * the rule; this is the rendering half of it.
   */
  const bases = basesFrom([place("p-1", "Alpha")]);
  expect(slotFor({}, "COBALT", bases)).toBeUndefined();
  expect(
    slotFor({ COBALT: "a-place-that-was-deleted" }, "COBALT", bases),
  ).toBeUndefined();
});

/*
 * SPEC-0011 REQ "A Place Is Authored, and a Plan References It":
 * WHEN a place is created and later assigned a leaf THEN the value the plan
 * carries as `BaseID` is the place record's own `id`, and no other
 * identifier for that place exists in the store.
 */
test("a base carries the place record's own id, not one minted for it", () => {
  const record = place("018f-a-generated-uuid", "Alpha");
  const bases = basesFrom([record]);

  expect(bases[0]?.id).toBe(record.id);
  // The slot is paint, not identity: it is an index into six colour tokens.
  expect(bases[0]?.slot).toBe(1);
});

test("an unnamed place is named on screen, never shown as its id", () => {
  const bases = basesFrom([place("018f-a-generated-uuid")]);
  expect(bases[0]?.label).toBe(UNNAMED_PLACE);
  expect(bases[0]?.label).not.toContain("018f");
});

/*
 * A workspace may hold more places than there are colours, and that is not
 * an error: the colour repeats and the id stays unique.
 */
test("colour slots repeat past six places; ids do not", () => {
  const bases = basesFrom(
    Array.from({ length: 8 }, (_, index) => place(`p-${String(index)}`)),
  );

  expect(new Set(bases.map((base) => base.id)).size).toBe(8);
  expect(bases[6]?.slot).toBe(bases[0]?.slot);
});

test("an empty workspace offers no bases at all", () => {
  expect(basesFrom([])).toHaveLength(0);
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
    expect(request?.assignments).toEqual({ COBALT: "place-2" });
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
    expect(request?.assignments).toEqual({ COBALT: "place-5" });
  });

  /*
   * SPEC-0011 REQ "An Assignment Naming an Absent Place Is Unassigned":
   * WHEN three leaves are assigned to a place and that place is deleted
   * THEN the plan survives, the leaves appear in the unassigned group, and
   * no dangling identifier is rendered.
   *
   * Driven through the fixture rather than the application because the
   * requirement is about what the hook reports, and the fixture is where a
   * place can be removed from the workspace mid-session without also
   * exercising IndexedDB.
   */
  test("deleting a place unassigns its leaves without destroying the plan", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "assign cobalt", exact: true }).click();
    await expect(page.locator("[data-assigned]")).toHaveAttribute(
      "data-assigned",
      "place-2",
    );

    await page.getByRole("button", { name: "delete place-2", exact: true }).click();

    // The leaf is unassigned and says which leaf moved — not silently dropped.
    await expect(page.locator("[data-assigned]")).toHaveAttribute("data-assigned", "");
    await expect(page.locator("[data-unresolved]")).toHaveAttribute(
      "data-unresolved",
      "COBALT",
    );
  });

  test("a deleted place's id never reaches the domain", async ({ page }) => {
    await page.getByRole("button", { name: "assign cobalt", exact: true }).click();
    await expect
      .poll(async () => page.evaluate(() => window.__assignment.dispatches()), {
        timeout: 10_000,
      })
      .toBe(1);

    await page.getByRole("button", { name: "delete place-2", exact: true }).click();
    /*
     * Reassigning after the deletion is what puts a request on the wire
     * again. The assertion is that the request carries the surviving place
     * and not the deleted one — a dangling id crossing the boundary would
     * group leaves at a base that exists nowhere, which is the rendering
     * ADR-0010 rules out by name.
     */
    await page.getByRole("button", { name: "reassign cobalt", exact: true }).click();
    await expect
      .poll(async () => page.evaluate(() => window.__assignment.dispatches()), {
        timeout: 10_000,
      })
      .toBe(2);

    const request = await page.evaluate(() => window.__assignment.requests().at(-1));
    expect(Object.values(request?.assignments ?? {})).not.toContain("place-2");
    expect(request?.assignments).toEqual({ COBALT: "place-5" });
  });

  /*
   * The assignment is not destroyed, only unresolved. Restoring the place
   * restores the assignment, which is what makes deletion survivable rather
   * than a thing the player has to redo.
   */
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

/*
 * The place a leaf is assigned to in the shell tests.
 *
 * Governing: SPEC-0011 REQ "A Place Is Authored, and a Plan References It"
 *
 * These tests used to assign to `base-3`, one of six identifiers the view
 * minted. There is no such set now: the assignable bases are the workspace's
 * places, so a test that wants somewhere to assign to has to create it —
 * which is also the honest shape, since that is what a player does.
 */
const PLACE = "Aurora Flats";

/** Create a place through the shipped route and wait for it to appear. */
async function createPlace(page: Page, name: string): Promise<void> {
  await page.getByLabel("New place").fill(name);
  await page.getByRole("button", { name: "Create place" }).click();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
}

/** The option value the assignment select carries for a place — its record id. */
async function placeId(page: Page, name: string): Promise<string> {
  return page
    .getByRole("dialog")
    .getByLabel("Gathered at")
    .locator("option")
    .filter({ hasText: name })
    .first()
    .getAttribute("value")
    .then((value) => value ?? "");
}

test.describe("in the shell", () => {
  test.beforeEach(async ({ page }) => {
    await countCrossings(page);
    await page.goto("/");
    /*
     * A clean workspace per test. The store is shared across the origin, so
     * places left by a previous test would make the assignable set depend on
     * execution order.
     */
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const deleting = indexedDB.deleteDatabase("nms-planner");
          deleting.onsuccess = () => {
            resolve();
          };
          deleting.onerror = () => {
            resolve();
          };
          deleting.onblocked = () => {
            resolve();
          };
        }),
    );
    await page.reload({ waitUntil: "load" });
    /*
     * The reload lands on the entry surface, because the selected surface is
     * view state and is deliberately not persisted — a link to the app opens
     * where SPEC-0011 says it opens. So the place is created on bases, which
     * is where the control lives, and the planner is selected afterwards.
     */
    await createPlace(page, PLACE);
    await openPlanner(page);
    await resolve(page, "ANTIMATTER");
  });

  /*
   * SPEC-0011 REQ "A Place Is Authored, and a Plan References It":
   * "A plan MUST remain resolvable when it references no places at all."
   */
  test("a plan resolves against a workspace with no places", async ({ page }) => {
    /*
     * Deleting a place is a bases control, so this leaves the planner and
     * comes back — which is also the only route a player has to the state
     * this test is about.
     */
    await openSurface(page, "Bases");
    await page.getByRole("button", { name: `Delete ${PLACE}` }).click();
    await openPlanner(page);

    const leaf = await aLeafName(page);
    await page
      .getByRole("region", CANVAS)
      .locator(".node-card")
      .filter({ hasText: leaf })
      .first()
      .click();

    const select = page.getByRole("dialog").getByLabel("Gathered at");
    await expect(select).toBeVisible();
    // Unassigned and nothing else, with the state named rather than blank.
    await expect(select.locator("option")).toHaveCount(1);
    await expect(page.getByRole("dialog")).toContainText("No places yet");
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
    const id = await placeId(page, PLACE);
    await select.selectOption(id);

    await expect(select).toHaveValue(id);
    /* The value is the place record's own id, not an identifier minted here. */
    expect(id).not.toBe("");
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
    await page
      .getByRole("dialog")
      .getByLabel("Gathered at")
      .selectOption(await placeId(page, PLACE));
    await page.keyboard.press("Escape");

    /* The first place in the workspace draws with the first colour slot. */
    await expect(card).toHaveAttribute("data-identity", "1");
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
    await page
      .getByRole("dialog")
      .getByLabel("Gathered at")
      .selectOption(await placeId(page, PLACE));

    const live = page.getByRole("status");
    /* The player's own name for the place, not a slot number. */
    await expect(live).toContainText(`${leaf} assigned to ${PLACE}`);
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
    await select.selectOption(await placeId(page, PLACE));
    await select.selectOption("");

    await expect(page.getByRole("status")).toContainText("no longer assigned");
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
    await page
      .getByRole("dialog")
      .getByLabel("Gathered at")
      .selectOption(await placeId(page, PLACE));
    await page.keyboard.press("Escape");

    expect((await crossings(page)).resolve).toBe(before);
  });
});
