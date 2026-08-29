import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { countCrossings, crossings, payloadOrder } from "../helpers/crossings";

/*
 * Governing: ADR-0004 (React view layer), SPEC-0006 REQ "Graph Rendering
 * From the Boundary Payload"
 *
 * One payload in, the whole tree out — and the payload's order kept.
 *
 * Against the real application, because the requirement is about how many
 * times the canvas crosses the boundary and a unit test of the model
 * cannot cross it at all.
 */

const CANVAS = { name: "Dependency tree" } as const;

/** The real target the spec measures at: 36 nodes against the shipped artifact. */
const LARGE_TARGET = "ULTRAPROD2";

async function resolve(page: Page, target: string): Promise<void> {
  await page.getByLabel("Target").fill(target);
  await page.getByRole("button", { name: "Recompute" }).click();
  await expect(page.getByRole("region", CANVAS)).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByRole("region", CANVAS).locator(".node-card").first(),
  ).toBeVisible({ timeout: 30_000 });
}

test.beforeEach(async ({ page }) => {
  await countCrossings(page);
  await page.goto("/");
});

test("one crossing renders the whole tree", async ({ page }) => {
  await resolve(page, LARGE_TARGET);

  const cards = page.getByRole("region", CANVAS).locator(".node-card");
  const rendered = await cards.count();

  /*
   * The measured size of the real target, named rather than derived. A test
   * that compared the canvas to the payload alone would pass against a
   * canvas rendering a two-node tree.
   */
  expect(rendered, "the shipped artifact's tree changed size").toBe(36);

  const counted = await crossings(page);
  expect(counted.resolve, "the canvas crossed more than once").toBe(1);
  expect(counted.rollup + counted.power, "the canvas used another stage").toBe(0);
});

test("a second, larger tree still costs one crossing", async ({ page }) => {
  /*
   * The companion. One crossing for a six-node tree could be a coincidence
   * of a tree small enough to fit one call; the count has to hold as the
   * tree grows.
   */
  await resolve(page, "ANTIMATTER");
  expect((await crossings(page)).resolve).toBe(1);

  await resolve(page, LARGE_TARGET);
  expect((await crossings(page)).resolve).toBe(2);
});

test("the rendered node sequence is the payload's sequence", async ({ page }) => {
  await resolve(page, LARGE_TARGET);

  const payload = await payloadOrder(page);
  expect(payload.length, "the payload was not captured").toBe(36);

  const rendered = await page
    .getByRole("region", CANVAS)
    .locator(".node-card .node-name")
    .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""));

  expect(rendered).toEqual(payload);
});

test("tab order follows the payload's order, not the layout's", async ({ page }) => {
  /*
   * SPEC-0006 Accessibility Requirements: "focus visits nodes in the
   * payload's order, terminals first and target last". design.md calls
   * this a deliberate divergence from "tab order follows visual layout"
   * and worth not later "fixing", so it is asserted rather than assumed
   * from DOM order.
   */
  await resolve(page, "ANTIMATTER");
  const payload = await payloadOrder(page);

  const visited: string[] = [];
  await page.getByRole("region", CANVAS).locator(".node-card").first().focus();
  for (let i = 0; i < payload.length; i += 1) {
    const name = await page.evaluate(
      () => document.activeElement?.querySelector(".node-name")?.textContent ?? "",
    );
    if (name === "") break;
    visited.push(name);
    await page.keyboard.press("Tab");
  }

  expect(visited).toEqual(payload);
});

test("each node is one tab stop, not two", async ({ page }) => {
  /*
   * React Flow makes its node wrapper focusable by default, which would put
   * a stop on the wrapper and another on the card inside it. The requirement
   * is one stop per node, so `nodesFocusable` is off — and this is what
   * notices if that default comes back.
   */
  await resolve(page, "ANTIMATTER");
  const canvas = page.getByRole("region", CANVAS);

  const perNode = await canvas
    .locator(
      '.react-flow__node [tabindex]:not([tabindex="-1"]), .react-flow__node button',
    )
    .count();
  const cards = await canvas.locator(".node-card").count();

  expect(cards).toBeGreaterThan(0);
  expect(perNode, "a node contributes more than one tab stop").toBe(cards);
});

test("the only other stop in the canvas is React Flow's attribution", async ({
  page,
}) => {
  /*
   * There is one more focusable element in the region and it is the
   * library's attribution link. It stays: removing it is what React Flow
   * sells a Pro subscription for, so hiding it would be a licence decision
   * dressed up as an accessibility fix.
   *
   * Asserted by name rather than by count so that a *different* extra stop
   * appearing later — a control, a handle that became focusable — fails
   * here instead of being absorbed into an off-by-one.
   */
  await resolve(page, "ANTIMATTER");
  const canvas = page.getByRole("region", CANVAS);

  const extra = await canvas
    .locator('[tabindex]:not([tabindex="-1"]), button, a[href]')
    .evaluateAll((nodes) =>
      nodes
        .filter((node) => !node.classList.contains("node-card"))
        .map((node) => node.getAttribute("href") ?? node.tagName),
    );

  expect(extra).toEqual(["https://reactflow.dev/attribution"]);
});

test("no comparator exists in the canvas source", async () => {
  /*
   * The acceptance criterion words it as an absence — "no sort or
   * comparator exists in the canvas source" — and an absence cannot be
   * shown by rendering a tree that happens to come out in order. A payload
   * that arrived already sorted would pass every ordering test above
   * against a canvas that sorted it again.
   */
  const directory = path.join(import.meta.dirname, "..", "..", "src", "canvas");
  const { readdirSync } = await import("node:fs");
  const files = readdirSync(directory).filter(
    (name) => name.endsWith(".ts") || name.endsWith(".tsx"),
  );

  expect(files.length, "the canvas sources were not found").toBeGreaterThanOrEqual(5);

  const COMPARATOR = /\.\s*sort\s*\(|\.\s*reverse\s*\(|localeCompare|\bcomparator\b/;
  for (const file of files) {
    const source = readFileSync(path.join(directory, file), "utf8");
    /* Comments explain why there is no comparator; blank them before scanning. */
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    expect(COMPARATOR.test(code), `canvas/${file} orders the nodes itself`).toBe(false);
  }

  /* The scan catches what it is for. */
  expect(COMPARATOR.test("const ordered = nodes.sort(byName);")).toBe(true);
  expect(COMPARATOR.test("a.name.localeCompare(b.name)")).toBe(true);
  expect(COMPARATOR.test("const model = toCanvasModel(graph);")).toBe(false);
});
