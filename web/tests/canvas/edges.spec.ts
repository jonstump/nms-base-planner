import { expect, test, type Page } from "@playwright/test";

import { openPlanner } from "../helpers/surfaces";

import { toCanvasModel } from "../../src/canvas/graph-model";
import { asQuantity } from "../../src/boundary/quantity";
import { countCrossings, payloadEdges } from "../helpers/crossings";
import type { Quantity, ResolvedGraph } from "../../src/boundary";

/*
 * Governing: ADR-0004 (React view layer), SPEC-0006 REQ "Edge Rendering",
 * REQ "Graph Rendering From the Boundary Payload"
 *
 * Three claims, and the third is the one worth reading:
 *
 *   - an edge carries the per-unit quantity relating its two nodes
 *   - the method of the node an edge feeds is readable from the edge
 *   - "WHEN edge styling is disregarded entirely THEN every fact it
 *     conveyed remains available as text on the connected nodes"
 *
 * The last cannot be checked by looking at edges. It is checked by
 * establishing what the styling distinguishes and then finding that same
 * fact as text on the card the edge points at.
 */

const CANVAS = { name: "Dependency tree" } as const;

function q(value: string): Quantity {
  const quantity = asQuantity(value);
  if (quantity === null) throw new Error(`${value} is not a quantity`);
  return quantity;
}

async function resolve(page: Page, target: string): Promise<void> {
  await page.getByLabel("Target").fill(target);
  await page.getByRole("button", { name: "Recompute" }).click();
  await expect(
    page.getByRole("region", CANVAS).locator(".node-card").first(),
  ).toBeVisible({ timeout: 30_000 });
}

test.beforeEach(async ({ page }) => {
  await countCrossings(page);
  await page.goto("/");
  await openPlanner(page);
});

/* ----------------------------------------------------------------------
 * Edges come from children, and only from children
 * ------------------------------------------------------------------- */

test("an edge is drawn for each child, and none is invented", () => {
  const graph: ResolvedGraph = {
    target: "TOP",
    quantity: q("1"),
    gameVersion: "5.0",
    nodes: [
      {
        itemId: "A",
        name: "A",
        total: q("1"),
        method: "raw",
        legalMethods: ["raw"],
        recipe: null,
        legalRecipes: [],
        yield: null,
        applications: null,
        terminal: true,
        verified: true,
        children: [],
      },
      {
        itemId: "B",
        name: "B",
        total: q("1"),
        method: "raw",
        legalMethods: ["raw"],
        recipe: null,
        legalRecipes: [],
        yield: null,
        applications: null,
        terminal: true,
        verified: true,
        children: [],
      },
      {
        itemId: "TOP",
        name: "Top",
        total: q("1"),
        method: "craft",
        legalMethods: ["craft"],
        recipe: "r",
        legalRecipes: ["r"],
        yield: null,
        applications: null,
        terminal: false,
        verified: true,
        children: [{ to: "A", perUnit: q("2"), yield: q("1") }],
      },
    ],
  };

  const model = toCanvasModel(graph);

  /*
   * B is a node with no edge to it. A canvas that inferred edges — from
   * adjacency, from "every terminal feeds the target", from anything — would
   * connect it, and the payload does not say that.
   */
  expect(model.edges).toEqual([
    { id: "A->TOP", source: "A", target: "TOP", perUnit: "2", targetMethod: "craft" },
  ]);
  expect(model.nodes.map((node) => node.id)).toEqual(["A", "B", "TOP"]);
});

/* ----------------------------------------------------------------------
 * The rendered surface
 * ------------------------------------------------------------------- */

test("every edge shows the per-unit quantity the payload gave it", async ({ page }) => {
  await resolve(page, "ULTRAPROD2");
  const canvas = page.getByRole("region", CANVAS);

  const expected = await payloadEdges(page);
  expect(expected.length, "the payload carried no edges").toBeGreaterThan(10);

  const rendered = await canvas
    .locator(".edge-label")
    .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""));

  expect(rendered.length, "an edge went unlabelled").toBe(expected.length);
  expect([...rendered].sort()).toEqual([...expected.map((edge) => edge.perUnit)].sort());
});

test("edges feeding a refine step are distinguished from those feeding a craft", async ({
  page,
}) => {
  await resolve(page, "ANTIMATTER");
  const canvas = page.getByRole("region", CANVAS);

  const styles = await canvas.locator(".tree-edge").evaluateAll((nodes) =>
    nodes.map((node) => {
      const computed = getComputedStyle(node);
      return {
        method: node.getAttribute("data-method") ?? "",
        stroke: computed.stroke,
        dash: computed.strokeDasharray,
      };
    }),
  );

  const refine = styles.filter((style) => style.method === "refine");
  const craft = styles.filter((style) => style.method === "craft");
  expect(refine.length, "no refine-fed edge in this tree").toBeGreaterThan(0);
  expect(craft.length, "no craft-fed edge in this tree").toBeGreaterThan(0);

  /*
   * Distinguished by two properties, not one. A reader who cannot separate
   * the two stroke colours still has the dash pattern, which is the
   * "not by colour alone" rule applied to a line.
   */
  expect(refine[0]?.dash).not.toBe(craft[0]?.dash);
  expect(refine[0]?.stroke).not.toBe(craft[0]?.stroke);
});

test("disregarding edge styling entirely loses no fact", async ({ page }) => {
  /*
   * The requirement's own scenario. What the styling conveys is the method
   * of the node the edge feeds; the check is that the same word is text on
   * that node's card.
   *
   * Done for every edge rather than a sample, because the failure this
   * guards against is one node type whose card omits the badge.
   */
  await resolve(page, "ULTRAPROD2");
  const canvas = page.getByRole("region", CANVAS);

  const expected = await payloadEdges(page);
  const methodsOnCards = await canvas.locator(".react-flow__node").evaluateAll((nodes) =>
    Object.fromEntries(
      nodes.map((node) => [
        node.getAttribute("data-id") ?? "",
        /* The word, not the glyph beside it. The glyph is aria-hidden,
         * so this is also what a screen reader is left with — and the
         * requirement is that the fact survive as text. */
        node.querySelector(".node-method span:not([aria-hidden])")?.textContent?.trim() ??
          "",
      ]),
    ),
  );

  for (const edge of expected) {
    const target = edge.id.split("->")[1] ?? "";
    expect(
      methodsOnCards[target],
      `the method an edge into ${target} conveys is not text on its card`,
    ).toBe(edge.targetMethod);
  }
});

test("the per-unit figure is text, not a line thickness", async ({ page }) => {
  /*
   * A width proportional to a quantity would be a visual fact derived from
   * a domain value, which SPEC-0006 REQ "Layout Geometry Is Not a Domain
   * Value" prohibits — and it would put the figure somewhere unreadable.
   * Every edge is the same width regardless of what it carries.
   */
  await resolve(page, "ULTRAPROD2");

  const widths = await page
    .getByRole("region", CANVAS)
    .locator(".tree-edge")
    .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).strokeWidth));

  expect(new Set(widths).size, "edge width varies, and only quantity varies").toBe(1);
});

test("with edge styling actually removed, every fact it carried is still there", async ({
  page,
}) => {
  /*
   * #89's acceptance criterion words this precisely: the test "removes
   * styling rather than reasoning about it, so 'the fact is also in the
   * text' is observed and not argued".
   *
   * The companion test above argues it — it reads each edge's method off a
   * data attribute and finds the same word on the card. That is a claim
   * about the model, and it would still pass if the styling were the only
   * thing a *person* could see.
   *
   * So this one flattens the styling for real: every edge is forced to one
   * stroke, one dash pattern and one width. The first assertion is that the
   * flattening worked — without it, "the facts survived" would be true
   * because nothing was removed.
   */
  await resolve(page, "ANTIMATTER");
  const canvas = page.getByRole("region", CANVAS);

  const before = await canvas.locator(".tree-edge").evaluateAll((nodes) =>
    nodes.map((node) => {
      const style = getComputedStyle(node);
      return `${style.stroke}|${style.strokeDasharray}`;
    }),
  );
  expect(
    new Set(before).size,
    "the edges were already identical, so removing styling proves nothing",
  ).toBeGreaterThan(1);

  await page.addStyleTag({
    content: `.tree-edge, .tree-edge[data-method] {
      stroke: rgb(128 128 128) !important;
      stroke-dasharray: none !important;
      stroke-width: 1.5px !important;
    }
    .edge-label, .edge-label[data-method] {
      color: rgb(128 128 128) !important;
      background-color: transparent !important;
      border-color: transparent !important;
    }`,
  });

  const after = await canvas.locator(".tree-edge").evaluateAll((nodes) =>
    nodes.map((node) => {
      const style = getComputedStyle(node);
      return `${style.stroke}|${style.strokeDasharray}`;
    }),
  );
  expect(new Set(after).size, "the styling did not actually flatten").toBe(1);

  /*
   * Now every fact the appearance carried has to be readable as text. The
   * per-unit quantity is on the edge's own label; the method it fed is on
   * the card it points at.
   */
  const expected = await payloadEdges(page);
  const labels = await canvas
    .locator(".edge-label")
    .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""));
  expect([...labels].sort()).toEqual([...expected.map((edge) => edge.perUnit)].sort());

  const methodsOnCards = await canvas
    .locator(".react-flow__node")
    .evaluateAll((nodes) =>
      Object.fromEntries(
        nodes.map((node) => [
          node.getAttribute("data-id") ?? "",
          node.querySelector(".node-method")?.textContent ?? "",
        ]),
      ),
    );
  for (const edge of expected) {
    const target = edge.id.split("->")[1] ?? "";
    expect(
      methodsOnCards[target],
      `with styling gone, nothing says the edge into ${target} feeds a ${edge.targetMethod} step`,
    ).toContain(edge.targetMethod);
  }
});
