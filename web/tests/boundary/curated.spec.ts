import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { CURATED_SCHEMA_VERSION, parseCurated } from "../../src/boundary/curated";
import type { Curated } from "../../src/boundary/requests";

/*
 * Governing: ADR-0001 (two-tier ingestion — Tier 2 is hand-maintained),
 * SPEC-0001 REQ "Provenance Propagation", SPEC-0002 REQ "Exact Quantity
 * Encoding", SPEC-0005 REQ "Module Loading"
 *
 * The curated set: the file, the loader, and the engine's acceptance of it.
 *
 * The loader is checked against the real data/tier2.json rather than a
 * fixture. A fixture would prove the parser parses something, and the thing
 * that actually breaks is the file — it is hand-edited, which is the whole
 * point of Tier 2, and an edit that produces a set the engine refuses is
 * the failure this suite exists to catch before a player does.
 */

const REPO = path.join(import.meta.dirname, "..", "..", "..");
const TIER2 = path.join(REPO, "data", "tier2.json");
const FIXTURE = "/tests/fixtures/boundary.html";

function parseShipped(): Curated {
  const outcome = parseCurated(readFileSync(TIER2, "utf8"));
  if (outcome.kind !== "ok") {
    throw new Error(`data/tier2.json does not load: ${outcome.message}`);
  }
  return outcome.value;
}

/** The seven the engine refuses to default, by their wire names. */
const SCALARS = [
  "biodomeCropSlots",
  "faunaYieldPerCycle",
  "faunaCycleSeconds",
  "stepsPerProcessor",
  "depotThreshold",
  "processSeconds",
  "panelsPerBattery",
] as const;

test("the shipped file supplies every constant the engine refuses to default", () => {
  const curated = parseShipped();
  for (const field of SCALARS) {
    expect(curated[field], `${field} is missing from data/tier2.json`).toMatch(
      /^[1-9]\d*$/,
    );
  }
});

test("the shipped file claims nothing has been verified in game", () => {
  /*
   * Today's honest state, asserted rather than assumed. SPEC-0001 REQ
   * "Provenance Propagation" makes an absent date taint every figure
   * derived from the constant, so this is what puts the unverified badge on
   * every producer row.
   *
   * This test is expected to change. When someone confirms a constant in
   * game and writes the date, the assertion below should be narrowed to the
   * ones still unconfirmed — not deleted, because "some constants are
   * verified" is a claim worth keeping honest too.
   */
  expect(parseShipped().verifiedOn).toBeUndefined();
});

test("a verified date is keyed by the name the domain looks it up under", () => {
  /*
   * The two spellings that have to agree: `biodomeCropSlots` in the file,
   * "biodome crop slots" in internal/domain/rollup.go. A mismatch is
   * invisible — the engine finds no entry, reads the constant as
   * unverified, and every figure is correctly computed and wrongly badged
   * — so the names are read out of the Go source rather than retyped here.
   */
  const source = readFileSync(path.join(REPO, "internal", "domain", "rollup.go"), "utf8");
  const names = [...source.matchAll(/^\tConstant\w+\s+= "([^"]+)"$/gm)].map(
    (match) => match[1],
  );
  expect(names.length, "the Constant* block was not found in rollup.go").toBe(
    SCALARS.length,
  );

  const withDates = readFileSync(TIER2, "utf8").replaceAll(
    '"verified": null',
    '"verified": "2026-09-20"',
  );
  const outcome = parseCurated(withDates);
  expect(outcome.kind).toBe("ok");
  if (outcome.kind !== "ok") return;

  expect(Object.keys(outcome.value.verifiedOn ?? {}).sort()).toEqual([...names].sort());
});

test("the classification maps arrive as the engine reads them", () => {
  const curated = parseShipped();

  /* Gas and Mineral are the categories tier1.json's hotspot table names. */
  const categories = new Set(Object.values(curated.resourceHotspots ?? {}));
  expect([...categories].sort()).toEqual(["Gas", "Mineral"]);
  expect(curated.resourceHotspots?.GAS1).toBe("Gas");

  expect(curated.faunaProducts).toContain("FOOD_V_MILK");
});

test("the shipped file declares the schema this build reads", () => {
  /*
   * Governing: ADR-0001 (Tier 2 is hand-maintained)
   *
   * The file carries a version and the loader enforces it, the way Tier 1
   * does in internal/domain/tier1.go and the durable store does in
   * web/src/store/durable-store.ts. A version written and never read is
   * worse than none: it looks like a guard while guarding nothing.
   */
  const raw: unknown = JSON.parse(readFileSync(TIER2, "utf8"));
  expect((raw as { schema_version?: unknown }).schema_version).toBe(
    CURATED_SCHEMA_VERSION,
  );
});

test("a file from the wrong side of a schema change is refused, naming both versions", () => {
  /*
   * The case a version exists for is not a missing field — that already
   * fails on its own — but a field whose meaning changed. Seconds becoming
   * milliseconds reads as a perfectly valid file and sizes every producer
   * wrongly, and the version is the only thing that can catch it.
   */
  const raw: Record<string, unknown> = JSON.parse(readFileSync(TIER2, "utf8")) as Record<
    string,
    unknown
  >;

  for (const wrong of [CURATED_SCHEMA_VERSION + 1, CURATED_SCHEMA_VERSION - 1]) {
    const outcome = parseCurated(JSON.stringify({ ...raw, schema_version: wrong }));
    expect(outcome.kind, `schema version ${String(wrong)} was accepted`).toBe("failed");
    if (outcome.kind !== "failed") continue;
    expect(outcome.code).toBe("CONSTANTS_INVALID");
    expect(outcome.message).toContain(String(wrong));
    expect(outcome.message).toContain(String(CURATED_SCHEMA_VERSION));
  }

  const missing = { ...raw };
  delete missing["schema_version"];
  const outcome = parseCurated(JSON.stringify(missing));
  expect(outcome.kind, "a file with no schema_version was accepted").toBe("failed");
});

test("a bad edit is refused here, naming the field", () => {
  const good = readFileSync(TIER2, "utf8");
  const bad = (from: string, to: string): string => {
    const text = good.replace(from, to);
    expect(text, `the file no longer contains ${from}`).not.toBe(good);
    return text;
  };

  const cases: { readonly text: string; readonly mentions: string }[] = [
    { text: bad('"value": "16"', '"value": "0"'), mentions: "biodomeCropSlots" },
    { text: bad('"value": "16"', '"value": "-4"'), mentions: "biodomeCropSlots" },
    { text: bad('"value": "16"', '"value": "3/2"'), mentions: "biodomeCropSlots" },
    { text: bad('"value": "16"', '"value": 16'), mentions: "biodomeCropSlots" },
    { text: bad('"value": "360"', '"value": "1,000"'), mentions: "depotThreshold" },
    {
      text: bad('"panelsPerBattery"', '"panelsPerBatery"'),
      mentions: "panelsPerBattery",
    },
    { text: bad('"verified": null', '"verified": 20260920'), mentions: "verified" },
    { text: "not json at all", mentions: "JSON" },
  ];

  for (const { text, mentions } of cases) {
    const outcome = parseCurated(text);
    expect(outcome.kind, `${mentions} should have been refused`).toBe("failed");
    if (outcome.kind !== "failed") continue;
    expect(outcome.code).toBe("CONSTANTS_INVALID");
    expect(outcome.message).toContain(mentions);
  }
});

test("a malformed classification map is refused rather than silently thinned", () => {
  /*
   * Dropping the one bad entry would leave an item classified as neither
   * fauna nor a hotspot resource, which reads downstream as a deliberate
   * omission rather than as the typo it is.
   */
  const text = readFileSync(TIER2, "utf8").replace('"FOOD_V_BLOB",', '"FOOD_V_BLOB", 7,');
  const outcome = parseCurated(text);
  expect(outcome.kind).toBe("failed");
  if (outcome.kind === "failed") expect(outcome.message).toContain("faunaProducts");
});

test("the build installs it where the browser asks for it", async ({ page }) => {
  /*
   * scripts/build-wasm.sh copies data/tier2.json into web/public/. Fetched
   * through the dev server rather than read off disk: the path the loader
   * uses is the thing being checked, and a file that exists in data/ but
   * was never installed fails exactly here.
   */
  await page.goto(FIXTURE, { waitUntil: "load" });
  const served = await page.evaluate(async () => {
    const response = await fetch("/tier2.json");
    return { ok: response.ok, text: await response.text() };
  });

  expect(served.ok, "/tier2.json is not served — did build-wasm.sh run?").toBe(true);
  expect(parseCurated(served.text).kind).toBe("ok");
  expect(served.text).toBe(readFileSync(TIER2, "utf8"));
});

async function callRollup(
  page: Page,
  request: unknown,
): Promise<{
  kind: string;
  code?: string;
  value?: unknown;
}> {
  return page.evaluate(async (payload) => {
    await window.__boundary.start();
    return (await window.__boundary.rollup(payload)) as {
      kind: string;
      code?: string;
      value?: unknown;
    };
  }, request);
}

test("the real engine accepts the real file and sizes a gas extractor", async ({
  page,
}) => {
  /*
   * The end of the chain: the shipped file, parsed by the shipped loader,
   * crossing into the shipped module. Every other test here could pass with
   * a set the engine refuses.
   *
   * Sulphurine is assigned to a configured base, so the resource-hotspot
   * map is exercised rather than merely present — an extractor cannot be
   * sized at all without it.
   */
  await page.goto(FIXTURE, { waitUntil: "load" });

  const outcome = await callRollup(page, {
    plan: { target: "ULTRAPROD2", quantity: "1" },
    assignments: { GAS1: "A" },
    sites: { A: { extractorClass: "B", fillSeconds: "5400" } },
    constants: parseShipped(),
  });

  expect(outcome.kind, `rollup failed: ${outcome.code ?? ""}`).toBe("ok");
  const build = outcome.value as {
    bases: {
      base: string;
      extractors: { itemId: string; extractorCount: string; verified: boolean }[];
    }[];
  };
  const extractors = build.bases.find((b) => b.base === "A")?.extractors ?? [];
  const sulphurine = extractors.find((row) => row.itemId === "GAS1");
  expect(sulphurine, "no extractor was sized for Sulphurine").toBeDefined();
  expect(sulphurine?.extractorCount).toMatch(/^[1-9]\d*$/);

  /*
   * And unverified, because nothing in the shipped file carries a date.
   * SPEC-0001 REQ "Provenance Propagation" — the row rests on the depot
   * threshold whether or not it reports depots, so the taint reaches it.
   */
  expect(sulphurine?.verified).toBe(false);
});

test("an unclassified resource is refused by name rather than guessed at", async ({
  page,
}) => {
  /*
   * The resource-hotspot map is deliberately partial. This is what makes
   * that safe: Condensed Carbon is not hotspot-extractable and is not in
   * the map, and a base configured to extract it is told so by name instead
   * of being sized against a category nobody chose.
   */
  await page.goto(FIXTURE, { waitUntil: "load" });

  const outcome = await callRollup(page, {
    plan: { target: "ULTRAPROD2", quantity: "1" },
    assignments: { FUEL2: "A" },
    sites: { A: { extractorClass: "B", fillSeconds: "5400" } },
    constants: parseShipped(),
  });

  expect(outcome.kind).toBe("failed");
  expect(outcome.code).toBe("MISSING_CONSTANT");
});
