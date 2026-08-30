import { expect, test, type Page } from "@playwright/test";

import { openPlanner, chooseTarget } from "../helpers/surfaces";

import { toCanvasModel, toLayoutInput } from "../../src/canvas/graph-model";
import { NODE_HEIGHT, NODE_WIDTH, toElkGraph } from "../../src/canvas/layout";
import { asQuantity } from "../../src/boundary/quantity";
import type { Quantity, ResolvedGraph } from "../../src/boundary";

/*
 * Governing: ADR-0004 (React view layer), SPEC-0006 REQ "Layout Geometry Is
 * Not a Domain Value", SPEC-0005 REQ "The View Computes No Domain Values"
 *
 * SPEC-0006 carves layout out of SPEC-0005's no-arithmetic rule and draws
 * the line at what the computation may read. design.md is explicit about
 * why the line is drawn there rather than argued each time: "pass nodes and
 * edges to the layout engine and never a total, and the question of whether
 * a coordinate is a domain value never arises."
 *
 * So this file checks the line twice. Once structurally — the exact object
 * that reaches the engine — and once behaviourally, by changing the target
 * quantity in the real application and requiring every position to come
 * back byte-identical. The second is the test the spec itself names, and it
 * is the one that would catch a quantity reaching the engine by a route
 * this file did not think to scan.
 */

function q(value: string): Quantity {
  const quantity = asQuantity(value);
  if (quantity === null) throw new Error(`${value} is not a quantity`);
  return quantity;
}

/*
 * Distinctive quantities, so a leak is unambiguous. `918273` appears
 * nowhere else in the project, and `5/6` is the rational shape the real
 * payload actually produces.
 */
const FIXTURE: ResolvedGraph = {
  target: "WIDGET",
  quantity: q("3"),
  gameVersion: "5.0",
  nodes: [
    {
      itemId: "ORE",
      name: "Ore",
      total: q("918273"),
      method: "raw",
      legalMethods: ["raw"],
      recipe: null,
      legalRecipes: [],
      yield: q("445566"),
      applications: q("5/6"),
      terminal: true,
      verified: true,
      children: [],
    },
    {
      itemId: "WIDGET",
      name: "Widget",
      total: q("112233"),
      method: "craft",
      legalMethods: ["craft"],
      recipe: "widget_craft",
      legalRecipes: ["widget_craft"],
      yield: q("778899"),
      applications: q("7/2"),
      terminal: false,
      verified: true,
      children: [{ to: "ORE", perUnit: q("334455"), yield: q("667788") }],
    },
  ],
};

/** Every primitive anywhere in a value, however nested. */
function everyValue(value: unknown, out: unknown[] = []): unknown[] {
  if (value === null || typeof value !== "object") {
    out.push(value);
    return out;
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    everyValue(entry, out);
  }
  return out;
}

/* ----------------------------------------------------------------------
 * The line, structurally
 * ------------------------------------------------------------------- */

test("the layout input carries structure and nothing else", () => {
  const { nodes, edges } = toLayoutInput(toCanvasModel(FIXTURE));

  expect(nodes).toEqual([
    { id: "ORE", width: NODE_WIDTH, height: NODE_HEIGHT },
    { id: "WIDGET", width: NODE_WIDTH, height: NODE_HEIGHT },
  ]);
  expect(edges).toEqual([{ id: "ORE->WIDGET", source: "ORE", target: "WIDGET" }]);
});

test("no quantity from the payload survives into the layout input", () => {
  /*
   * The scan, rather than the shape assertion above, is what would catch a
   * field added later. A new key holding a total would satisfy `toEqual`
   * only if someone updated the expectation — and they would.
   */
  const quantities = [
    "918273",
    "445566",
    "5/6",
    "112233",
    "778899",
    "7/2",
    "334455",
    "667788",
  ];
  const seen = everyValue(toLayoutInput(toCanvasModel(FIXTURE))).map(String);

  for (const quantity of quantities) {
    expect(seen, `the quantity ${quantity} reached the layout engine`).not.toContain(
      quantity,
    );
  }
});

test("the object handed to the engine has exactly the allowed keys", () => {
  /*
   * The engine is a third party and takes whatever it is given. The types
   * keep a quantity out of `LayoutNode`; this keeps one out of the object
   * that actually crosses, which is the thing the requirement is about.
   */
  const { nodes, edges } = toLayoutInput(toCanvasModel(FIXTURE));
  const graph = toElkGraph(nodes, edges) as unknown as Record<string, unknown>;

  expect(Object.keys(graph).sort()).toEqual(["children", "edges", "id", "layoutOptions"]);

  for (const child of graph["children"] as Record<string, unknown>[]) {
    expect(Object.keys(child).sort()).toEqual(["height", "id", "width"]);
  }
  for (const edge of graph["edges"] as Record<string, unknown>[]) {
    expect(Object.keys(edge).sort()).toEqual(["id", "sources", "targets"]);
  }

  /*
   * The options are a frozen literal of engine settings. Scanned too,
   * because "elk.layered.spacing.nodeNodeBetweenLayers: total" would be a
   * quantity reaching the engine through a door nobody was watching.
   */
  const options = graph["layoutOptions"] as Record<string, string>;
  for (const value of Object.values(options)) {
    expect(value).not.toMatch(/^\d+\/\d+$/);
  }
});

test("the scanner catches a quantity that did reach the input", () => {
  /*
   * The negative control. Every assertion above passes against a scanner
   * that returns an empty array.
   */
  const leaked = everyValue({
    nodes: [{ id: "ORE", width: NODE_WIDTH, height: NODE_HEIGHT, total: "918273" }],
  }).map(String);
  expect(leaked).toContain("918273");
});

/* ----------------------------------------------------------------------
 * The line, behaviourally
 * ------------------------------------------------------------------- */

const CANVAS = { name: "Dependency tree" } as const;

async function positionsFor(page: Page, quantity: string): Promise<string[]> {
  await page.getByLabel("Quantity").fill(quantity);
  await page.getByRole("button", { name: "Recompute" }).click();

  const canvas = page.getByRole("region", CANVAS);
  await expect(canvas.locator(".node-card").first()).toBeVisible({ timeout: 30_000 });

  return canvas
    .locator(".react-flow__node")
    .evaluateAll((nodes) =>
      nodes.map(
        (node) =>
          `${node.getAttribute("data-id") ?? ""}@${(node as HTMLElement).style.transform}`,
      ),
    );
}

test("changing the target quantity does not move a single node", async ({ page }) => {
  /*
   * The scenario SPEC-0006 states: "WHEN the target quantity changes and
   * every total scales THEN node positions are unchanged, because no
   * position was derived from a total."
   *
   * Compared as strings, so this is byte-identical rather than
   * approximately equal. A layout that derived x from a total would move by
   * a sub-pixel amount for a small quantity change and pass a tolerance.
   */
  await page.goto("/");
  await openPlanner(page);
  await chooseTarget(page, "ULTRAPROD2");

  const atOne = await positionsFor(page, "1");
  expect(atOne.length, "no nodes were placed").toBe(36);

  const atSeven = await positionsFor(page, "7");
  expect(atSeven).toEqual(atOne);

  const atLarge = await positionsFor(page, "9999");
  expect(atLarge).toEqual(atOne);
});

test("the totals did change, so the comparison above means something", async ({
  page,
}) => {
  /*
   * The companion, and it is not optional. If the recompute silently failed
   * and the canvas kept rendering the first result, every position would be
   * identical for the wrong reason and the test above would pass against a
   * broken application.
   */
  await page.goto("/");
  await openPlanner(page);
  await chooseTarget(page, "ULTRAPROD2");

  await positionsFor(page, "1");
  const first = await page
    .getByRole("region", CANVAS)
    .locator(".node-total")
    .first()
    .innerText();

  await positionsFor(page, "7");
  const second = await page
    .getByRole("region", CANVAS)
    .locator(".node-total")
    .first()
    .innerText();

  expect(second).not.toBe(first);
});
