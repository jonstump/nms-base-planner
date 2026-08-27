import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import {
  messageInspections,
  navigations,
  numericConversions,
} from "../helpers/source-checks";

/*
 * Governing: SPEC-0005 REQ "Boundary Client", REQ "The View Computes No
 * Domain Values", Security Requirements → Redirect Validation
 *
 * The three criteria that are about absences.
 *
 * "Every failure branch selects on the error code; no test or source matches
 * on message text" cannot be shown by exercising failures — it is a claim
 * about every branch, including the ones a test did not think to reach. Same
 * for arithmetic and for navigation. So these read the source, and each
 * checker is run against a snippet containing the mistake so a checker that
 * has stopped matching fails here rather than passing forever.
 */

const BOUNDARY = path.join(import.meta.dirname, "..", "..", "src", "boundary");
const TESTS = import.meta.dirname;

function sourcesIn(directory: string): { file: string; source: string }[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({
      file: name,
      source: readFileSync(path.join(directory, name), "utf8"),
    }));
}

test("the boundary sources exist and were actually read", () => {
  /*
   * Every assertion below is satisfied by an empty directory. This is what
   * separates "nothing is wrong" from "nothing was looked at".
   */
  expect(sourcesIn(BOUNDARY).length).toBeGreaterThanOrEqual(7);
});

test("no boundary source branches on an error message", () => {
  for (const { file, source } of sourcesIn(BOUNDARY)) {
    expect(messageInspections(file, source), `${file} inspects a message`).toEqual([]);
  }
});

test("no boundary test branches on an error message either", () => {
  /*
   * The criterion says "no test or source". A test that asserted on message
   * text would pin prose the contract does not promise, and the next domain
   * change would break the test rather than the code.
   */
  for (const { file, source } of sourcesIn(TESTS)) {
    /*
     * This file is the one exception, and has to be: its negative controls
     * are string literals containing exactly the constructs being banned. A
     * checker cannot be shown to work without somewhere holding an example
     * of what it catches.
     */
    if (file === "discipline.spec.ts") continue;
    expect(messageInspections(file, source), `${file} inspects a message`).toEqual([]);
  }
});

test("no boundary source turns a quantity into a number", () => {
  for (const { file, source } of sourcesIn(BOUNDARY)) {
    expect(numericConversions(file, source), `${file} converts to a number`).toEqual([]);
  }
});

test("nothing that can see plan state can navigate", () => {
  /*
   * module.ts is excluded because it assigns `script.src` to load the Go
   * shim — a fixed path from its own constructor argument. The exclusion is
   * only safe if plan state cannot reach it, which the next test checks.
   */
  for (const { file, source } of sourcesIn(BOUNDARY)) {
    if (file === "module.ts") continue;
    expect(navigations(file, source), `${file} navigates`).toEqual([]);
  }
});

test("module.ts cannot see plan state", () => {
  const source = readFileSync(path.join(BOUNDARY, "module.ts"), "utf8");
  expect(source).not.toMatch(/from "\.\/plan(-hash)?"/);
  expect(source).not.toMatch(/\bdecodePlanFromHash\b|\bvalidatePlan\b/);
});

test("the checks reject source broken on purpose", () => {
  expect(
    messageInspections("x.ts", `if (error.message === "unknown item") retry();`),
  ).toHaveLength(1);
  expect(
    messageInspections("x.ts", `if (error.message.includes("cycle")) bail();`),
  ).toHaveLength(1);
  expect(
    messageInspections("x.ts", `if (/cycle/.test(error.message)) bail();`),
  ).toHaveLength(1);
  expect(
    messageInspections("x.ts", `switch (payload.message) { default: break; }`),
  ).toHaveLength(1);

  expect(numericConversions("x.ts", `const total = Number(node.total);`)).toHaveLength(1);
  expect(
    numericConversions("x.ts", `const total = parseFloat(node.total);`),
  ).toHaveLength(1);
  expect(
    numericConversions("x.ts", `const rounded = Math.ceil(applications);`),
  ).toHaveLength(1);
  expect(numericConversions("x.ts", `const shown = value.toFixed(2);`)).toHaveLength(1);

  expect(navigations("x.ts", `location.href = plan.target;`)).toHaveLength(1);
  expect(navigations("x.ts", `window.open(decoded.target);`)).toHaveLength(1);
  expect(navigations("x.ts", `history.pushState({}, "", decoded.target);`)).toHaveLength(
    1,
  );
});

test("the checks do not fire on legitimate code", () => {
  /*
   * The companion. A checker that matched everything would satisfy every
   * assertion above and make the suite useless.
   */
  expect(
    messageInspections("x.ts", `return failure(code, \`could not read \${detail}\`);`),
  ).toEqual([]);
  expect(
    messageInspections("x.ts", `if (outcome.code === "NOT_READY") retry();`),
  ).toEqual([]);
  expect(
    messageInspections("x.ts", `typeof message === "string" ? message : fallback;`),
  ).toEqual([]);
  expect(
    messageInspections("x.ts", `if (raw.message === undefined) return null;`),
  ).toEqual([]);
  expect(numericConversions("x.ts", `const text = String(response.status);`)).toEqual([]);
  expect(numericConversions("x.ts", `const joined = prefix + suffix;`)).toEqual([]);
  expect(navigations("x.ts", `const target = plan.target;`)).toEqual([]);
});

test("a comment naming a forbidden construct is not a finding", () => {
  /*
   * Every one of these files explains why it does not do the thing. A
   * checker that read the explanation as the offence would have to be
   * silenced, and a silenced checker watches nothing.
   */
  const commented = `// never Number(quantity), never location.href = decoded, never message.includes("x")\nexport const x = 1;`;
  expect(numericConversions("x.ts", commented)).toEqual([]);
  expect(navigations("x.ts", commented)).toEqual([]);
  expect(messageInspections("x.ts", commented)).toEqual([]);
});
