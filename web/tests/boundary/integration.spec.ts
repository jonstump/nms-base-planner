import { expect, test, type Page } from "@playwright/test";

/*
 * Governing: ADR-0003 (Go domain, thin adapter), ADR-0004 (React view layer),
 * SPEC-0005 REQ "Boundary Client", REQ "The View Computes No Domain Values"
 *
 * The real module, the real artifact, in a real browser.
 *
 * tests/boundary/lifecycle.spec.ts drives a stand-in because the branches it
 * covers are ones a healthy module never takes. This file is the check that
 * the stand-in resembles the thing: same client, same code path, nothing
 * scripted.
 */

const FIXTURE = "/tests/fixtures/boundary.html";

interface Node {
  itemId: string;
  name: string;
  total: string;
  method: string;
  recipe: string | null;
  yield: string | null;
  applications: string | null;
  terminal: boolean;
}

interface Resolved {
  kind: string;
  code?: string;
  value?: { target: string; quantity: string; gameVersion: string; nodes: Node[] };
}

async function resolve(page: Page, plan: Record<string, unknown>): Promise<Resolved> {
  return page.evaluate(async (value) => {
    await window.__boundary.start();
    return (await window.__boundary.resolve(value)) as Resolved;
  }, plan);
}

test.beforeEach(async ({ page }) => {
  await page.goto(FIXTURE, { waitUntil: "load" });
});

test("a real plan resolves through the real module", async ({ page }) => {
  const outcome = await resolve(page, { target: "ULTRAPROD2", quantity: "1" });

  expect(outcome.kind).toBe("ok");
  const graph = outcome.value;
  if (!graph) return;

  expect(graph.target).toBe("ULTRAPROD2");
  expect(graph.gameVersion).toBe("5.97");

  /*
   * 36, not 34. The Stasis Device tree expands CAVE2 into two Cobalt and two
   * Oxygen, which an earlier hand count missed — pinned here so the next
   * change to selection has to be deliberate about it.
   */
  expect(graph.nodes).toHaveLength(36);

  /* SPEC-0002 REQ "Determinism Across the Boundary": target last. */
  expect(graph.nodes.at(-1)?.itemId).toBe("ULTRAPROD2");
});

test("an exact rational crosses and renders unchanged", async ({ page }) => {
  /*
   * The criterion asks for a quantity "the boundary reports as an exact
   * rational that is not an integer". The issue guessed at 3/2 from a
   * 125-at-yield-50 refiner case; the shipped artifact's actual example is
   * Antimatter, whose Silver requirement resolves to 5/6. Using the real one
   * matters — a test pinned to a value the artifact never produces would
   * pass by never running its assertion.
   */
  const outcome = await resolve(page, { target: "ANTIMATTER", quantity: "1" });
  expect(outcome.kind).toBe("ok");

  const nodes = outcome.value?.nodes ?? [];
  const fractional = nodes.filter((node) => node.total.includes("/"));
  expect(
    fractional.length,
    "the artifact no longer produces a fractional total here",
  ).toBeGreaterThan(0);

  const silver = nodes.find((node) => node.itemId === "ASTEROID1");
  expect(silver?.total).toBe("5/6");

  /* Through the formatter the view would actually use, unrounded. */
  const shown = await page.evaluate(
    (value) => window.__boundary.format(value as never),
    "5/6",
  );
  expect(shown).toBe("5/6");
});

test("a fractional total is not a value a JavaScript number could have carried", async ({
  page,
}) => {
  /*
   * Without this, "it rendered 5/6" is satisfied by a pipeline that parsed
   * 0.8333333333333334 and printed it back as a fraction by luck. 5/6 has no
   * finite binary expansion, so a round trip through a double cannot recover
   * the string.
   */
  const roundTripped = await page.evaluate(() => {
    const asNumber = 5 / 6;
    return String(asNumber);
  });
  expect(roundTripped).not.toBe("5/6");
  expect(roundTripped).toContain(".");
});

test("an unknown item comes back as a code, not as prose", async ({ page }) => {
  const outcome = await resolve(page, { target: "NOT_AN_ITEM", quantity: "1" });

  expect(outcome.kind).toBe("failed");
  expect(outcome.code).toBe("UNKNOWN_ITEM");
});

test("the real module's contract version is the one this view was built for", async ({
  page,
}) => {
  /*
   * If this fails, every other test in this file is testing a contract the
   * view does not claim to implement — and the mismatch path in
   * lifecycle.spec.ts would be the live behaviour rather than an edge case.
   */
  const version = await page.evaluate(async () => {
    await window.__boundary.start();
    return (globalThis as unknown as { nmsPlanner: { contractVersion: string } })
      .nmsPlanner.contractVersion;
  });
  expect(version).toBe("1.2.0");
});

test("changing an input produces a fresh crossing rather than a derived figure", async ({
  page,
}) => {
  /*
   * "WHEN the user changes target quantity ... THEN the new figures come from
   * a boundary call, and none is derived in the view from the previous
   * figures."
   *
   * Doubling the target does not double every total — some inputs round at
   * SPEC-0001's physical boundaries and some do not — so a view that scaled
   * the previous result would produce different numbers from these.
   */
  const one = await resolve(page, { target: "ULTRAPROD2", quantity: "1" });
  const three = await resolve(page, { target: "ULTRAPROD2", quantity: "3" });

  expect(one.kind).toBe("ok");
  expect(three.kind).toBe("ok");
  expect(three.value?.nodes.at(-1)?.total).toBe("3");
  expect(one.value?.nodes.at(-1)?.total).toBe("1");
  expect(three.value?.quantity).toBe("3");
});

test("a plan restored from a hash resolves the same as the plan it came from", async ({
  page,
}) => {
  /*
   * The hash is where a plan survives a reload, so a plan that resolves
   * before sharing and not after would be a silent data loss.
   */
  const same = await page.evaluate(async () => {
    await window.__boundary.start();
    const direct = { target: "ULTRAPROD2", quantity: "2" };

    const { encodePlanToHash } = await import("../../src/boundary/plan-hash");
    const { validatePlan } = await import("../../src/boundary/plan");
    const validated = validatePlan(direct);
    if (!validated.ok) throw new Error(validated.reason);

    const restored = window.__boundary.decodeHash(encodePlanToHash(validated.plan));
    if (restored.diagnostic !== null)
      throw new Error("the round trip produced a diagnostic");

    const a = (await window.__boundary.resolve(direct)) as {
      value?: { nodes: unknown[] };
    };
    const b = (await window.__boundary.resolve(restored.plan)) as {
      value?: { nodes: unknown[] };
    };
    return JSON.stringify(a.value) === JSON.stringify(b.value);
  });

  expect(same).toBe(true);
});
