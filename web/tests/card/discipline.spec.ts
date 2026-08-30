import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { domainArithmetic, numericConversions } from "../helpers/source-checks";

/*
 * Governing: SPEC-0007 REQ "Card Composition From the Build Payload",
 * SPEC-0005 REQ "The View Computes No Domain Values"
 *
 * "No quantity-divided-by-rate appears anywhere in the card's source —
 * checkable mechanically, the way tests/boundary/discipline.spec.ts already
 * checks the boundary."
 *
 * This is the same claim about an absence that the boundary's suite makes,
 * so it runs the same checker rather than a second copy of it: a rule
 * enforced by two regexes drifts the moment one is improved. What differs is
 * the directory and the extension — the card is .tsx, and the boundary's
 * scan is .ts only.
 *
 * The temptation this catches is specific and real. A farm row carries both
 * `required` and `yieldPerPlant`, so `required / yieldPerPlant.min` looks
 * like the plant count and is not: SPEC-0007 requires the domain's `plants`
 * "even where both are present in the payload", because the engine sizes on
 * the pessimistic bound and rounds where the domain says to round.
 */

const CARD = path.join(import.meta.dirname, "..", "..", "src", "card");

function cardSources(): { file: string; source: string }[] {
  return readdirSync(CARD)
    .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
    .map((name) => ({
      file: name,
      source: readFileSync(path.join(CARD, name), "utf8"),
    }));
}

test("there are card sources to check", () => {
  /*
   * Every assertion below is vacuously satisfied by an empty directory.
   * This separates "the card does no arithmetic" from "nothing was read".
   */
  const files = cardSources().map(({ file }) => file);
  expect(files.length).toBeGreaterThan(0);
  expect(files).toContain("BasePlannerCard.tsx");
});

test("no card source converts a quantity to a number or rounds one", () => {
  const findings = cardSources().flatMap(({ file, source }) =>
    numericConversions(file, source),
  );
  expect(findings).toEqual([]);
});

test("the checker still catches the mistake it exists to catch", () => {
  /*
   * The negative control. A checker that returned an empty array
   * unconditionally passes the assertion above and fails this one, which is
   * the only way to tell a working check from one that has quietly stopped
   * matching. The snippet is the exact error: deriving a plant count from a
   * required quantity and a yield.
   */
  const broken = `const plants = Math.ceil(Number(row.required) / Number(row.yieldPerPlant.min));`;
  expect(numericConversions("broken.tsx", broken).length).toBeGreaterThan(0);
});

/*
 * The half this file's own header claimed and did not perform.
 *
 * `numericConversions` matches `Number(`, `parseInt`, `Math.` and `+` on a
 * quantity-shaped name. It does not match `/` or `-`, because the shared
 * checker deliberately leaves arithmetic operators alone — `+` concatenates
 * strings everywhere and flagging it would get the checker switched off.
 *
 * So "no quantity-divided-by-rate appears in the card's source" was written
 * at the top of this file and enforced by nothing. `domainArithmetic` is
 * the operator half, scoped to the domain's own vocabulary and to spaced
 * operators so hyphenated class names and JSX's `/>` cannot match.
 */

test("no card source divides a quantity by a rate or subtracts one figure from another", () => {
  const sources = cardSources();
  expect(sources.length).toBeGreaterThan(0);

  for (const { file, source } of sources) {
    expect(
      domainArithmetic(file, source),
      `card/${file} computes a figure the payload already carries`,
    ).toEqual([]);
  }
});

test("the operator checker catches both constructs it exists for", () => {
  /*
   * The two the requirements name. The first is SPEC-0007's farm row: a
   * card carrying `required` and `yieldPerPlant` can produce the plant
   * count itself, and must not. The second is the power shortfall, where
   * the computed answer equals the payload's — which is exactly why no
   * rendered assertion can tell them apart.
   */
  expect(
    domainArithmetic("x.tsx", "const plants = required / yieldPerPlant.min;"),
  ).toHaveLength(1);
  expect(domainArithmetic("x.tsx", "const shortfall = generation - draw;")).toHaveLength(
    1,
  );
  expect(domainArithmetic("x.tsx", "const each = total / panels;")).toHaveLength(1);
});

test("the operator checker does not fire on the code the card actually contains", () => {
  /*
   * The companion, and the reason the pattern is narrow. A checker that
   * matched a hyphenated class name, a JSX self-close or a loop counter
   * would be reported as a false positive and switched off, which is how a
   * rule stops being enforced without anyone deciding to stop enforcing it.
   */
  expect(domainArithmetic("x.tsx", '<span className="card-row-name" />')).toEqual([]);
  expect(domainArithmetic("x.tsx", "<Figure label={label} value={value} />")).toEqual([]);
  expect(
    domainArithmetic("x.tsx", "for (let i = 0; i < rows.length - 1; i += 1) {"),
  ).toEqual([]);
  expect(domainArithmetic("x.tsx", "const total = formatQuantity(row.total);")).toEqual(
    [],
  );
});
