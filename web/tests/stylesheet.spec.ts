import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import {
  colourLiterals,
  insetBoxShadows,
  untokenizedColourProperties,
} from "./helpers/css-checks";

/*
 * Governing: ADR-0004 (React view layer), SPEC-0005 REQ "Token Discipline",
 * REQ "Component Styling Discipline"
 *
 * ADR-0004's Confirmation says token discipline is "verified by grep for #
 * literals outside the token file". The grep is right; leaving it in a review
 * checklist is not. These run it, and — the part a checklist cannot do — run
 * each check against a stylesheet broken on purpose, so a check that has
 * quietly stopped matching anything fails here rather than passing forever.
 */

const STYLES = path.join(import.meta.dirname, "..", "src", "styles");
const TOKEN_FILE = "tokens.css";

/*
 * Discovered rather than listed.
 *
 * A hard-coded list goes stale in the direction that matters: a stylesheet
 * added and not listed is simply never checked, and nothing fails. #60
 * deleted reference.css and added shell.css, which a list would have
 * survived by quietly checking one fewer file than exists.
 */
const COMPONENT_FILES = readdirSync(STYLES)
  .filter((name) => name.endsWith(".css") && name !== TOKEN_FILE)
  .sort();

function read(name: string): string {
  return readFileSync(path.join(STYLES, name), "utf8");
}

test("there is more than one stylesheet to check", () => {
  /*
   * Every per-file assertion below is vacuously satisfied by an empty list.
   * This is what separates "no stylesheet has a literal" from "no stylesheet
   * was looked at".
   */
  expect(COMPONENT_FILES.length).toBeGreaterThan(0);
  expect(COMPONENT_FILES).toContain("base.css");
});

test.describe("token discipline", () => {
  for (const name of COMPONENT_FILES) {
    test(`${name} carries no colour literal`, () => {
      expect(colourLiterals(read(name))).toEqual([]);
    });

    test(`${name} resolves every colour through a custom property`, () => {
      expect(untokenizedColourProperties(read(name))).toEqual([]);
    });
  }

  test("the token file is where the literals actually live", () => {
    /*
     * Without this, every assertion above is satisfied by a project that had
     * no colours at all — and by a checker that had stopped matching. It
     * asserts the exclusion is load-bearing: the literals exist, and they are
     * in exactly one file.
     */
    expect(colourLiterals(read(TOKEN_FILE)).length).toBeGreaterThan(20);
  });
});

test.describe("component styling discipline", () => {
  for (const name of [TOKEN_FILE, ...COMPONENT_FILES]) {
    test(`${name} declares no inset box-shadow`, () => {
      expect(insetBoxShadows(read(name))).toEqual([]);
    });
  }
});

/*
 * The negative controls.
 *
 * Each check is fed a stylesheet containing exactly the mistake it exists to
 * catch. A check that returns an empty array unconditionally passes every
 * assertion above and fails every assertion below, which is the only way to
 * tell the two apart.
 */
test.describe("the checks reject a stylesheet broken on purpose", () => {
  test("a hex literal is caught", () => {
    const broken = `.node { color: #fe8019; }`;
    expect(colourLiterals(broken)).toHaveLength(1);
  });

  test("a functional colour is caught, including syntaxes not yet used here", () => {
    const broken = [
      `.a { color: rgb(254 128 25); }`,
      `.b { color: hsl(27deg 99% 55%); }`,
      `.c { color: oklch(75% 0.18 55); }`,
      `.d { color: color-mix(in oklch, red, blue); }`,
      `.e { color: lab(70% 40 60); }`,
    ].join("\n");
    expect(colourLiterals(broken)).toHaveLength(5);
  });

  test("a bare named colour is caught", () => {
    const broken = `.node { background-color: black; }`;
    expect(colourLiterals(broken)).toHaveLength(1);
  });

  test("a literal inside a comment is not a finding", () => {
    /*
     * The token file's comments quote hexes while explaining them, and the
     * base stylesheet's comments name `inset box-shadow` to say why it is
     * absent. A check that read either as a violation would have to be
     * silenced, and a silenced check is the failure mode this suite exists
     * to prevent.
     */
    const clean = `/* #fe8019 is the accent; never use inset box-shadow */\n.node { color: var(--accent); }`;
    expect(colourLiterals(clean)).toEqual([]);
    expect(insetBoxShadows(clean)).toEqual([]);
  });

  test("a colour property that stopped resolving through a token is caught", () => {
    const broken = `.node { border-color: inherit; }\n.other { color: ButtonText; }`;
    /*
     * `inherit` is legitimate — it carries no colour of its own. `ButtonText`
     * is a system colour: no literal, no token, and a real colour. Only the
     * second is a finding.
     */
    expect(untokenizedColourProperties(broken)).toHaveLength(1);
  });

  test("an inset box-shadow is caught wherever inset sits in the value", () => {
    const broken = [
      `.a { box-shadow: inset 0 0 0 2px var(--ok); }`,
      `.b { box-shadow: 0 0 0 2px var(--ok) inset; }`,
    ].join("\n");
    expect(insetBoxShadows(broken)).toHaveLength(2);
  });

  test("an outboard box-shadow is not an inset box-shadow", () => {
    expect(insetBoxShadows(`.a { box-shadow: 0 1px 2px var(--ok); }`)).toEqual([]);
  });
});
