import { expect, test, type Page } from "@playwright/test";

import type { Curated } from "../../src/boundary/requests";

/*
 * Governing: ADR-0003 (Go domain, thin adapter), ADR-0004 (React view
 * layer), SPEC-0002 REQ "Boundary Surface"
 *
 * Stage 2 and stage 3 against the real module and the real artifact.
 *
 * tests/boundary/stages.spec.ts drives the decoders with hand-built
 * payloads, which proves they decode what this file says the wire looks
 * like. This proves that is what the wire actually looks like.
 */

const FIXTURE = "/tests/fixtures/boundary.html";

/*
 * The Tier 2 constant set. SPEC-0001 design.md requires these be injected
 * rather than defaulted, and the engine refuses a partially-specified set
 * and names the constant it is missing — so a request that omits one fails
 * loudly rather than silently using a number nobody chose.
 *
 * Values mirror internal/domain/power_test.go's set.
 */
const CONSTANTS = {
  biodomeCropSlots: "16",
  faunaYieldPerCycle: "12",
  faunaCycleSeconds: "1800",
  stepsPerProcessor: "2",
  depotThreshold: "1000",
  processSeconds: "30",
  panelsPerBattery: "2",
  faunaProducts: [],
  resourceHotspots: {},
};

interface Outcome {
  kind: string;
  code?: string;
  value?: unknown;
}

async function callRollup(page: Page, request: unknown): Promise<Outcome> {
  return page.evaluate(async (payload) => {
    await window.__boundary.start();
    return (await window.__boundary.rollup(payload)) as Outcome;
  }, request);
}

async function callPower(page: Page, request: unknown): Promise<Outcome> {
  return page.evaluate(async (payload) => {
    await window.__boundary.start();
    return (await window.__boundary.power(payload)) as Outcome;
  }, request);
}

test.beforeEach(async ({ page }) => {
  await page.goto(FIXTURE, { waitUntil: "load" });
});

test("rollup crosses and returns a build", async ({ page }) => {
  const outcome = await callRollup(page, {
    plan: { target: "ULTRAPROD2", quantity: "1" },
    constants: CONSTANTS,
  });

  expect(outcome.kind, `rollup failed: ${outcome.code ?? ""}`).toBe("ok");
  const build = outcome.value as { bases: unknown[]; unassigned: unknown[] };
  expect(Array.isArray(build.bases)).toBe(true);
  expect(Array.isArray(build.unassigned)).toBe(true);
});

test("unassigned leaves are reported rather than lost", async ({ page }) => {
  /*
   * With no assignments, every leaf is unplaced. The producer stage skips
   * them because there is no site to build them at, and the payload carries
   * them so the view can say so rather than showing an empty build.
   */
  const outcome = await callRollup(page, {
    plan: { target: "ULTRAPROD2", quantity: "1" },
    constants: CONSTANTS,
  });

  expect(outcome.kind).toBe("ok");
  const build = outcome.value as { unassigned: { itemId: string; total: string }[] };
  expect(build.unassigned.length).toBeGreaterThan(0);
  expect(build.unassigned[0]?.total).toMatch(/^-?\d+(\/\d+)?$/);
});

test("power crosses and returns a budget with the domain's own balance", async ({
  page,
}) => {
  const outcome = await callPower(page, {
    sources: { A: { emGenerators: "4", emClass: "C" } },
    draws: { A: [{ partId: "BUILDLIGHT", count: "10" }] },
    constants: CONSTANTS,
  });

  expect(outcome.kind, `power failed: ${outcome.code ?? ""}`).toBe("ok");
  const power = outcome.value as {
    bases: {
      base: string;
      generation: string;
      draw: string;
      balance: string;
      fixUnsized: boolean;
    }[];
  };

  const budget = power.bases[0];
  expect(budget?.base).toBe("A");
  for (const figure of [budget?.generation, budget?.draw, budget?.balance]) {
    expect(figure, "a power figure did not cross as an exact quantity").toMatch(
      /^-?\d+(\/\d+)?$/,
    );
  }
  expect(typeof budget?.fixUnsized).toBe("boolean");
});

test("a deficit with no class configured crosses as fixUnsized", async ({ page }) => {
  /*
   * The state design.md warns an implementer would conclude was nothing to
   * show. Configuring draw with no generator class leaves the domain unable
   * to size the fix — and it reports that rather than reporting zero
   * additional generators and letting the view guess why.
   */
  const outcome = await callPower(page, {
    sources: { A: { emGenerators: "0" } },
    draws: { A: [{ partId: "BUILDLIGHT", count: "50" }] },
    constants: CONSTANTS,
  });

  expect(outcome.kind, `power failed: ${outcome.code ?? ""}`).toBe("ok");
  const power = outcome.value as {
    bases: { inDeficit: boolean; additionalGenerators: string; fixUnsized: boolean }[];
  };

  const budget = power.bases[0];
  expect(budget?.inDeficit, "the base should be in deficit").toBe(true);
  expect(budget?.fixUnsized, "no class is configured, so the fix cannot be sized").toBe(
    true,
  );
  expect(budget?.additionalGenerators).toBe("0");
});

test("a missing curated constant is refused by name, not defaulted", async ({ page }) => {
  /*
   * SPEC-0001 design.md: "Tier 2 constants injected, never hardcoded." The
   * engine refuses a partial set. This asserts the client surfaces that as
   * a stable code rather than the request silently succeeding with a number
   * nobody chose.
   */
  const partial: Record<string, unknown> = { ...CONSTANTS };
  delete partial["depotThreshold"];
  const outcome = await callRollup(page, {
    plan: { target: "ULTRAPROD2", quantity: "1" },
    constants: partial,
  });

  expect(outcome.kind).toBe("failed");
  expect(outcome.code).toBeTruthy();
});

test("both stages return the same outcome shape as resolve", async ({ page }) => {
  /*
   * A component handles all three identically, which is only true if the
   * discriminant is the same. Typecheck covers the declaration; this covers
   * the runtime value.
   */
  const shapes = await page.evaluate(async (constants) => {
    await window.__boundary.start();
    const resolve = (await window.__boundary.resolve({
      target: "ULTRAPROD2",
      quantity: "1",
    })) as Record<string, unknown>;
    const rollup = (await window.__boundary.rollup({
      plan: { target: "ULTRAPROD2", quantity: "1" },
      constants,
    })) as Record<string, unknown>;
    const power = (await window.__boundary.power({ constants })) as Record<
      string,
      unknown
    >;
    return [resolve, rollup, power].map((outcome) =>
      Object.keys(outcome).sort().join(","),
    );
  }, CONSTANTS);

  expect(new Set(shapes).size, `outcome shapes differ: ${shapes.join(" | ")}`).toBe(1);
});

/*
 * The provenance round trip, against the real engine.
 *
 * Governing: SPEC-0001 REQ "Provenance Propagation", SPEC-0007 REQ
 * "Provenance on Displayed Figures"
 *
 * Every other test in this file exercises provenance's false branch by
 * accident — no request carries verified dates, so everything comes back
 * unverified and a client that could not send them at all would look
 * identical. That was the gap: `verifiedOn` was absent from the request
 * type, so the flag the decoders read carefully was permanently false and
 * the view had no way to say otherwise.
 *
 * A solar base is the cheapest true case. Its battery count is derived
 * entirely from `panels per battery`, so the budget's provenance is that one
 * constant's — no assignments, no hotspot configuration, no producer rows
 * needed to reach it.
 *
 * The three cases together are what make this meaningful. Asserting only the
 * true case would pass against a decoder that hardcoded `true`; asserting
 * only the pair would pass against one that tainted every base whenever any
 * date was missing.
 */
/*
 * The compile-time half of the guarantee.
 *
 * `callPower` takes `unknown` and the encoder is `JSON.stringify`, so at
 * runtime a caller could always put `verifiedOn` on the wire whether or not
 * the interface declared it — the field crossed fine before this change.
 * What was missing was the type: no one writing against `Curated` could see
 * the field existed, and a properly-typed call site would have been rejected
 * for using it.
 *
 * So the guard is a type assertion rather than an assertion in a test body.
 * `Pick<Curated, "verifiedOn">` does not compile if `Curated` has no such
 * key, which makes `npm run typecheck` fail the moment the field is removed.
 * The runtime tests below cannot do that job, and it is worth being precise
 * about which half each one covers.
 */
const VERIFIED_ON_IS_SENDABLE: Pick<Curated, "verifiedOn"> = {
  verifiedOn: { "panels per battery": "2026-08-28" },
};

test("a supplied verified date crosses and marks the budget verified", async ({
  page,
}) => {
  const solar = { sources: { A: { solarPanels: "4" } }, draws: {} };

  const withoutDates = await callPower(page, {
    ...solar,
    constants: CONSTANTS,
  });
  expect(withoutDates.kind, `power failed: ${withoutDates.code ?? ""}`).toBe("ok");
  const unverified = (withoutDates.value as { bases: { verified: boolean }[] }).bases[0];
  expect(
    unverified?.verified,
    "a battery count derived from an undated constant reported itself verified",
  ).toBe(false);

  const withDates = await callPower(page, {
    ...solar,
    constants: { ...CONSTANTS, ...VERIFIED_ON_IS_SENDABLE },
  });
  expect(withDates.kind, `power failed: ${withDates.code ?? ""}`).toBe("ok");
  const verified = (withDates.value as { bases: { verified: boolean }[] }).bases[0];
  expect(
    verified?.verified,
    "the supplied date did not reach the engine — verifiedOn is not crossing",
  ).toBe(true);
});

test("a base that reads no curated constant is not tainted by an absent date", async ({
  page,
}) => {
  /*
   * Electromagnetic generation reads the artifact's part rate and hotspot
   * strength, neither of which is curated. Without this case the pair above
   * is satisfied by an engine that taints every base whenever any date is
   * missing, which would make the flag useless rather than wrong.
   */
  const outcome = await callPower(page, {
    sources: { A: { emGenerators: "1", emClass: "B" } },
    draws: {},
    constants: CONSTANTS,
  });

  expect(outcome.kind, `power failed: ${outcome.code ?? ""}`).toBe("ok");
  const budget = (outcome.value as { bases: { verified: boolean; batteries: string }[] })
    .bases[0];
  expect(budget?.batteries).toBe("0");
  expect(
    budget?.verified,
    "a base running no panels was tainted by a constant it never reads",
  ).toBe(true);
});
