import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { openPlanner, chooseTarget } from "../helpers/surfaces";

import { METHOD_ORDER, methodOptions } from "../../src/canvas/methods";
import { countCrossings, crossings } from "../helpers/crossings";

/*
 * Governing: ADR-0004 (React view layer), ADR-0005 (multiple recipes per
 * output), SPEC-0006 REQ "Method Selection", Accessibility Requirements →
 * Keyboard Navigation, Focus Management
 *
 * Method selection only. The recipe half is #132 and is blocked on design:
 * the handoff has no answer for a control that must stay usable at
 * sixty-one options, and SPEC-0006 forbids stretching the segmented control
 * drawn for two.
 *
 * The claim that needs the most care is "the canvas MUST NOT compute which
 * methods are legal". A behavioural test cannot show it — a canvas that
 * computed legality and happened to agree with the payload would pass every
 * assertion below. So the options are compared against the payload's own
 * `legalMethods`, read out of the captured crossing, and the source is
 * scanned for the shortcuts a computing implementation would need.
 */

const CANVAS = { name: "Dependency tree" } as const;

async function resolve(page: Page, target: string): Promise<void> {
  await chooseTarget(page, target);
  await page.getByRole("button", { name: "Recompute" }).click();
  await expect(
    page.getByRole("region", CANVAS).locator(".node-card").first(),
  ).toBeVisible({ timeout: 30_000 });
}

/** The payload's own methods, per node, from the captured crossing. */
async function payloadMethods(
  page: Page,
): Promise<Record<string, { method: string; legal: string[] }>> {
  return page.evaluate(() => {
    const answer = window.__lastResolve;
    const parsed: unknown = typeof answer === "string" ? JSON.parse(answer) : answer;
    const nodes =
      (
        parsed as {
          data?: {
            graph?: {
              nodes?: { name?: string; method?: string; legalMethods?: string[] }[];
            };
          };
        }
      ).data?.graph?.nodes ?? [];
    return Object.fromEntries(
      nodes.map((node) => [
        node.name ?? "",
        { method: node.method ?? "", legal: node.legalMethods ?? [] },
      ]),
    );
  });
}

/**
 * A node the domain reports more than one method for, and the method it is
 * not currently on.
 *
 * Derived from the payload rather than named, because which nodes have an
 * alternative is a property of the shipped artifact. In the Antimatter tree
 * the terminals carry `raw/refine` while Chromatic Metal is refine-only —
 * hard-coding the wrong one is how this test first failed.
 */
function anAlternative(
  payload: Record<string, { method: string; legal: string[] }>,
): { name: string; from: string; to: string } | null {
  for (const [name, entry] of Object.entries(payload)) {
    const other = entry.legal.find((method) => method !== entry.method);
    if (other !== undefined) return { name, from: entry.method, to: other };
  }
  return null;
}

async function openControlFor(page: Page, name: string): Promise<void> {
  await page
    .getByRole("region", CANVAS)
    .locator(".node-card")
    .filter({ hasText: name })
    .first()
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

/* ----------------------------------------------------------------------
 * The option list, as a pure function
 * ------------------------------------------------------------------- */

test("the options are the payload's, and nothing else decides", () => {
  const options = methodOptions(["raw"], "raw", "Condensed Carbon");

  expect(options.map((option) => option.method)).toEqual([...METHOD_ORDER]);
  expect(options.filter((option) => option.available).map((o) => o.method)).toEqual([
    "raw",
  ]);
  expect(options.find((option) => option.current)?.method).toBe("raw");
});

test("an unavailable method is present and carries a reason", () => {
  const options = methodOptions(["raw"], "raw", "Condensed Carbon");
  const refine = options.find((option) => option.method === "refine");

  expect(refine, "refine was dropped from the list").toBeDefined();
  expect(refine?.available).toBe(false);
  expect(refine?.reason).toContain("Condensed Carbon");
  expect(refine?.reason).toContain("refine");
});

test("a selectable option carries no reason", () => {
  /*
   * The companion. A list where every option carried a reason would
   * satisfy the assertion above and tell the player nothing.
   */
  const options = methodOptions(["craft", "refine"], "craft", "Glass");
  for (const option of options.filter((o) => o.available)) {
    expect(option.reason, `${option.method} is available and still explained`).toBeNull();
  }
});

test("a method the payload reports and this file has never heard of is still offered", () => {
  /*
   * Dropping it would be the canvas deciding legality by omission, which is
   * the failure the requirement is about — just in the opposite direction
   * from the obvious one.
   */
  const options = methodOptions(["raw", "cook"], "cook", "Fried Something");
  const cook = options.find((option) => option.method === "cook");

  expect(cook?.available).toBe(true);
  expect(cook?.current).toBe(true);
  expect(options.map((o) => o.method).slice(0, 3)).toEqual([...METHOD_ORDER]);
});

test("the order is the design's, so the buttons do not move between nodes", () => {
  const terminal = methodOptions(["raw"], "raw", "A").map((o) => o.method);
  const crafted = methodOptions(["craft", "refine"], "craft", "B").map((o) => o.method);
  expect(terminal).toEqual(crafted);
});

/* ----------------------------------------------------------------------
 * Nothing in the canvas computes legality
 * ------------------------------------------------------------------- */

test("no canvas source decides a method for itself", () => {
  /*
   * The acceptance criterion asks for this to be "checkable by grep as
   * much as by test", and it is the half a behavioural test cannot do.
   *
   * `methods.ts` is the only file that builds the option list, and what it
   * must not do is reach for anything other than its arguments: not the
   * terminal flag, not the children, not an item identifier.
   */
  const directory = path.join(import.meta.dirname, "..", "..", "src", "canvas");
  const source = readFileSync(path.join(directory, "methods.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");

  for (const shortcut of ["terminal", "children", "itemId", "recipe"]) {
    expect(code.includes(shortcut), `methods.ts consults ${shortcut}`).toBe(false);
  }

  /*
   * And no other canvas source builds an option list of its own. Two
   * places deciding what is offered is two places to drift from the
   * payload.
   */
  const others = readdirSync(directory).filter(
    (name) => name !== "methods.ts" && (name.endsWith(".ts") || name.endsWith(".tsx")),
  );
  expect(others.length).toBeGreaterThan(3);
  for (const file of others) {
    const body = readFileSync(path.join(directory, file), "utf8").replace(
      /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
      "",
    );
    expect(body.includes("METHOD_ORDER"), `canvas/${file} builds its own list`).toBe(
      false,
    );
  }
});

/* ----------------------------------------------------------------------
 * The control, in the real application
 * ------------------------------------------------------------------- */

test.describe("in the shell", () => {
  test.beforeEach(async ({ page }) => {
    await countCrossings(page);
    await page.goto("/");
    await openPlanner(page);
    await resolve(page, "ANTIMATTER");
  });

  test("clicking a node opens its control", async ({ page }) => {
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await openControlFor(page, "Antimatter");
    await expect(page.getByRole("dialog").getByRole("heading")).toHaveText("Antimatter");
  });

  test("Enter opens the control from the keyboard alone", async ({ page }) => {
    /*
     * SPEC-0006: "Clicking or pressing Enter on a node MUST open a
     * control." Driven with keys rather than by calling a handler — the
     * card is a button, and this is what shows the keyboard route reaches
     * the same place the pointer does.
     */
    await page.getByRole("region", CANVAS).locator(".node-card").first().focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("the options offered are the payload's legalMethods", async ({ page }) => {
    const payload = await payloadMethods(page);
    const name = "Antimatter";
    const expected = payload[name];
    expect(expected, "the payload was not captured").toBeDefined();

    await openControlFor(page, name);

    const enabled = await page
      .getByRole("dialog")
      .locator(".node-method-option:not([disabled])")
      .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""));

    expect([...enabled].sort()).toEqual([...(expected?.legal ?? [])].sort());
  });

  test("an unavailable method is rendered, inert, and says why", async ({ page }) => {
    const payload = await payloadMethods(page);
    /* A terminal: the domain reports raw and nothing else. */
    const terminal = Object.entries(payload).find(
      ([, entry]) => entry.legal.length === 1 && entry.legal[0] === "raw",
    );
    expect(terminal, "no single-method node in this tree").toBeDefined();
    const name = terminal?.[0] ?? "";

    await openControlFor(page, name);
    const dialog = page.getByRole("dialog");

    const refine = dialog.locator(".node-method-option").filter({ hasText: "refine" });
    await expect(refine, "the unavailable option was hidden").toHaveCount(1);
    await expect(refine).toBeDisabled();

    /* The reason is text on the page, not a title attribute. */
    await expect(dialog).toContainText(`no refine route for ${name}`);
  });

  test("the control states the current route before anything changes", async ({
    page,
  }) => {
    /* Chromatic Metal: refine, with real inputs and a recipe yield. */
    await openControlFor(page, "Chromatic Metal");
    const dialog = page.getByRole("dialog");

    await expect(dialog).toContainText("Now");
    await expect(dialog.locator(".node-control-method")).toHaveText("refine");
    /* Its inputs, from the payload's own children. */
    await expect(dialog.locator(".node-control-inputs li").first()).toBeVisible();
    await expect(dialog).toContainText("recomputed by the planner");
  });

  test("choosing a method recomputes through the boundary, once", async ({ page }) => {
    const swap = anAlternative(await payloadMethods(page));
    expect(swap, "no node in this tree offers an alternative method").not.toBeNull();
    if (swap === null) return;

    const before = (await crossings(page)).resolve;
    expect(before).toBe(1);

    await openControlFor(page, swap.name);
    await page
      .getByRole("dialog")
      .locator(".node-method-option:not([disabled])")
      .filter({ hasText: swap.to })
      .click();

    await expect
      .poll(async () => (await crossings(page)).resolve, { timeout: 20_000 })
      .toBe(before + 1);

    /*
     * And no other stage was reached. A canvas that adjusted a figure
     * itself would show no second crossing at all; one that reached for
     * rollup would be doing stage 2's work.
     */
    const after = await crossings(page);
    expect(after.rollup + after.power).toBe(0);
  });

  test("the change is announced, naming what changed and that totals updated", async ({
    page,
  }) => {
    const swap = anAlternative(await payloadMethods(page));
    expect(swap, "no node in this tree offers an alternative method").not.toBeNull();
    if (swap === null) return;

    await openControlFor(page, swap.name);
    await page
      .getByRole("dialog")
      .locator(".node-method-option:not([disabled])")
      .filter({ hasText: swap.to })
      .click();

    const live = page.locator('[aria-live="polite"]');
    await expect(live).toContainText(`${swap.name} set to ${swap.to}`, {
      timeout: 20_000,
    });
    await expect(live).toContainText("Totals updated");
  });

  test("Escape closes the control and returns focus to the node", async ({ page }) => {
    const card = page
      .getByRole("region", CANVAS)
      .locator(".node-card")
      .filter({ hasText: "Antimatter" })
      .first();

    await card.click();
    await expect(page.getByRole("dialog")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(card).toBeFocused();
  });

  test("the close control returns focus too, not only Escape", async ({ page }) => {
    /*
     * The route an Escape-only implementation gets wrong. #82's trap
     * restores in the effect cleanup so all routes converge; this is what
     * notices if that stops being true.
     */
    const card = page
      .getByRole("region", CANVAS)
      .locator(".node-card")
      .filter({ hasText: "Antimatter" })
      .first();

    await card.click();
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(card).toBeFocused();
  });

  test("the backdrop returns focus too — the third route", async ({ page }) => {
    /*
     * #90 asks for every close route "each tested separately": Escape, the
     * backdrop, and the close control. The trap's backdrop route is proven
     * once on the shell's own popover in a11y-primitives.spec.ts; this
     * asserts it on *this* dialog, because a surface that added its own
     * backdrop handler would break here and nowhere else.
     */
    const card = page
      .getByRole("region", CANVAS)
      .locator(".node-card")
      .filter({ hasText: "Antimatter" })
      .first();

    await card.click();
    await expect(page.getByRole("dialog")).toBeVisible();

    /*
     * A corner, not the centre. The backdrop spans the viewport, so its
     * midpoint is underneath the dialog — `force: true` skips the
     * actionability check but still clicks the centre point, which lands on
     * the dialog and dismisses nothing. This cost a debugging detour.
     */
    await page.locator(".popover-backdrop").click({ position: { x: 8, y: 8 } });

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(card).toBeFocused();
  });

  test("focus stays inside the control while it is open", async ({ page }) => {
    await openControlFor(page, "Chromatic Metal");
    const dialog = page.getByRole("dialog");

    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press("Tab");
      await expect(
        dialog.locator(":focus"),
        `focus left on tab ${String(i)}`,
      ).toHaveCount(1);
    }
  });
});
