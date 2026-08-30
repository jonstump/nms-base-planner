import { expect, test } from "@playwright/test";

import { selectBuild } from "../../src/boundary/build";
import { selectPower } from "../../src/boundary/power";

/*
 * Governing: ADR-0004 (React view layer), SPEC-0002 REQ "Exact Quantity
 * Encoding", SPEC-0007 REQ "Card Composition From the Build Payload",
 * REQ "Deficit Is an Action, Including When It Cannot Be Sized"
 *
 * The stage 2 and stage 3 decoders. Same discipline the graph decoder
 * already holds: every quantity stays the string the boundary sent, and a
 * payload that does not validate is rejected whole rather than repaired —
 * a build missing one figure reads as a build that costs less than it does.
 */

/**
 * The payload minus one field.
 *
 * A helper rather than rest-destructuring: `const { x: _dropped, ...rest }`
 * leaves an unused binding the linter rightly objects to, and loosening the
 * rule for one idiom is a worse trade than one small function.
 */
function without<T extends object>(value: T, key: keyof T): Partial<T> {
  const copy: Partial<T> = { ...value };
  delete copy[key];
  return copy;
}

const BUDGET = {
  base: "A",
  generation: "600",
  draw: "450",
  balance: "150",
  deficit: "0",
  inDeficit: false,
  perGenerator: "150",
  batteries: "0",
  additionalGenerators: "0",
  fixUnsized: false,
  verified: false,
};

const FARM = {
  itemId: "LUSH1",
  name: "Paraffinium",
  required: "300",
  plants: "19",
  biodomes: "2",
  yieldPerPlant: { min: "16", max: "24" },
  growthSeconds: "1800",
  verified: false,
};

const BASE = {
  base: "A",
  site: { extractorClass: "C", fillSeconds: "5400" },
  /*
   * Required, not optional. Contract 1.3.0 added it, and the decoder refuses
   * a payload without it rather than assuming: assuming `true` would present
   * an unconfigured base's zeros as a configuration, and assuming `false`
   * would report every configured base as unconfigured. The version check is
   * what keeps an older module from reaching the decoder at all; this is the
   * second line.
   */
  configured: true,
  farms: [FARM],
  nutrientProcessors: "1",
  pelletFeeders: "0",
  verified: false,
};

test.describe("the build payload", () => {
  test("decodes a base and keeps every count as the domain sent it", () => {
    const build = selectBuild({ build: { bases: [BASE] } });
    expect(build).not.toBeNull();

    const base = build?.bases[0];
    expect(base?.base).toBe("A");
    expect(base?.farms[0]?.plants).toBe("19");
    expect(base?.farms[0]?.biodomes).toBe("2");
    expect(base?.nutrientProcessors).toBe("1");
  });

  test("both yield bounds survive", () => {
    /*
     * The domain sizes plants on the pessimistic bound and SPEC-0007 forbids
     * the card presenting the optimistic one as the planning figure. A
     * decoder that kept only one bound would make that requirement
     * unsatisfiable rather than merely unmet.
     */
    const build = selectBuild({ build: { bases: [BASE] } });
    expect(build?.bases[0]?.farms[0]?.yieldPerPlant).toEqual({ min: "16", max: "24" });
  });

  test("omitempty sections decode as empty, not as missing", () => {
    const build = selectBuild({ build: { bases: [BASE] } });
    const base = build?.bases[0];
    expect(base?.extractors).toEqual([]);
    expect(base?.ranches).toEqual([]);
    expect(base?.kitchen).toEqual([]);
    expect(base?.noBuild).toEqual([]);
    expect(build?.unassigned).toEqual([]);
  });

  test("a no-build row carries what covers it", () => {
    /*
     * SPEC-0007 REQ "Byproducts Are Shown, Not Omitted": an absent row is
     * indistinguishable from an overlooked requirement, so the decoder has
     * to carry the covering producer as well as the demand.
     */
    const build = selectBuild({
      build: {
        bases: [
          {
            ...BASE,
            noBuild: [
              {
                itemId: "CATALYST1",
                name: "Condensed Carbon",
                from: "gas refine",
                required: "300",
                verified: false,
              },
            ],
          },
        ],
      },
    });
    expect(build?.bases[0]?.noBuild[0]?.from).toBe("gas refine");
  });

  test("a row missing a required field rejects the whole payload", () => {
    /*
     * Not "drop the row". A build with one farm missing is a build the
     * player will follow and find short.
     */
    const withoutPlants = without(FARM, "plants");
    expect(
      selectBuild({ build: { bases: [{ ...BASE, farms: [withoutPlants] }] } }),
    ).toBeNull();
  });

  test("a quantity that is not exact rejects the payload", () => {
    expect(
      selectBuild({ build: { bases: [{ ...BASE, nutrientProcessors: 1 }] } }),
    ).toBeNull();
    expect(
      selectBuild({ build: { bases: [{ ...BASE, nutrientProcessors: "1.5" }] } }),
    ).toBeNull();
  });

  test("a missing verified flag is not coerced to false", () => {
    /*
     * `verified` carries meaning in its false case — SPEC-0007 requires the
     * card to mark unverified figures — so an absent flag is a payload this
     * view does not understand, not a definite "no".
     */
    const withoutVerified = without(BASE, "verified");
    expect(selectBuild({ build: { bases: [withoutVerified] } })).toBeNull();

    /*
     * `configured` for the same reason, and a sharper one.
     *
     * Governing: SPEC-0011 REQ "A Place Is Creatable by Hand"
     *
     * Its false case is the whole point: it is what tells the card to render
     * a gap rather than the site's zeros. A decoder that defaulted it to
     * true would present class "" for zero seconds as a configuration, which
     * is the configured-value-of-zero the requirement rules out; one that
     * defaulted it to false would report every configured base as
     * unconfigured. Neither guess is available, so the payload has to say.
     */
    expect(selectBuild({ build: { bases: [without(BASE, "configured")] } })).toBeNull();
  });

  test("anything that is not a build payload is rejected", () => {
    for (const bad of [
      null,
      {},
      { build: null },
      { build: {} },
      { build: { bases: "x" } },
    ]) {
      expect(selectBuild(bad), `${JSON.stringify(bad)} was accepted`).toBeNull();
    }
  });
});

test.describe("the power payload", () => {
  test("decodes a budget and keeps balance and deficit as the domain sent them", () => {
    const power = selectPower({ power: { bases: [BUDGET] } });
    const budget = power?.bases[0];

    expect(budget?.generation).toBe("600");
    expect(budget?.draw).toBe("450");
    expect(budget?.balance).toBe("150");
    expect(budget?.deficit).toBe("0");
  });

  test("a negative balance survives", () => {
    const power = selectPower({
      power: {
        bases: [
          {
            ...BUDGET,
            generation: "300",
            balance: "-150",
            deficit: "150",
            inDeficit: true,
          },
        ],
      },
    });
    expect(power?.bases[0]?.balance).toBe("-150");
    expect(power?.bases[0]?.deficit).toBe("150");
  });

  test("fixUnsized is decoded, not inferred from a zero generator count", () => {
    /*
     * The criterion this story exists to protect.
     *
     * design.md warns that an implementer working from the prototype alone
     * "would meet a budget in deficit with AdditionalGenerators of zero and
     * reasonably conclude there was nothing to show." These two payloads
     * differ in exactly one boolean and must decode differently — a decoder
     * that derived the flag from `additionalGenerators === "0"` would
     * collapse them.
     */
    const inDeficit = {
      ...BUDGET,
      generation: "300",
      balance: "-150",
      deficit: "150",
      inDeficit: true,
    };

    const sizeable = selectPower({
      power: { bases: [{ ...inDeficit, additionalGenerators: "1", fixUnsized: false }] },
    });
    const unsizeable = selectPower({
      power: { bases: [{ ...inDeficit, additionalGenerators: "0", fixUnsized: true }] },
    });
    const noDeficit = selectPower({
      power: { bases: [{ ...BUDGET, additionalGenerators: "0", fixUnsized: false }] },
    });

    expect(sizeable?.bases[0]?.fixUnsized).toBe(false);
    expect(unsizeable?.bases[0]?.fixUnsized).toBe(true);
    expect(noDeficit?.bases[0]?.fixUnsized).toBe(false);

    /* The two zero-generator cases are told apart by the flag alone. */
    expect(unsizeable?.bases[0]?.additionalGenerators).toBe(
      noDeficit?.bases[0]?.additionalGenerators,
    );
    expect(unsizeable?.bases[0]?.fixUnsized).not.toBe(noDeficit?.bases[0]?.fixUnsized);
  });

  test("a missing fixUnsized rejects the payload rather than defaulting", () => {
    const withoutFlag = without(BUDGET, "fixUnsized");
    expect(selectPower({ power: { bases: [withoutFlag] } })).toBeNull();
  });

  test("anything that is not a power payload is rejected", () => {
    for (const bad of [null, {}, { power: null }, { power: { bases: "x" } }]) {
      expect(selectPower(bad), `${JSON.stringify(bad)} was accepted`).toBeNull();
    }
  });
});
