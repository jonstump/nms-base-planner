/*
 * Three bases, three power positions, one real card.
 *
 * Governing: SPEC-0007 REQ "Power Position", REQ "Deficit Is an Action,
 * Including When It Cannot Be Sized", REQ "Build Rollup Footer"
 *
 * `unsized` is the fixture that matters. design.md warns that an implementer
 * meeting a budget in deficit with `additionalGenerators` of zero would
 * reasonably conclude there was nothing to show — so this fixture is exactly
 * that payload, with `fixUnsized` set, and the suite requires the deficit to
 * be visible anyway.
 *
 * `solar` is in deficit with no sized fix and no generator class. It exists
 * to assert an absence: the card offers no panel count, because the domain
 * reported none and computing one would be the card sizing a fix it was not
 * given.
 */

import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import {
  asQuantity,
  type BaseBuild,
  type PowerBudget,
  type Quantity,
} from "../../src/boundary";
import { BasePlannerCard } from "../../src/card/BasePlannerCard";

import "../../src/styles/tokens.css";
import "../../src/styles/base.css";
import "../../src/styles/shell.css";
import "../../src/styles/card.css";

function exact(value: string): Quantity {
  const quantity = asQuantity(value);
  if (quantity === null) throw new Error(`fixture quantity is not exact: ${value}`);
  return quantity;
}

function baseNamed(name: string): BaseBuild {
  return {
    base: name,
    site: { extractorClass: "C", fillSeconds: exact("3600") },
    farms: [
      {
        itemId: "starbulb",
        name: "Star Bulb",
        required: exact("480"),
        plants: exact("24"),
        biodomes: exact("2"),
        yieldPerPlant: { min: exact("20"), max: exact("30") },
        growthSeconds: exact("1800"),
        verified: true,
      },
    ],
    extractors: [
      {
        itemId: "dihydrogen",
        name: "Di-hydrogen",
        class: "C",
        required: exact("1250"),
        extractorCount: exact("3"),
        depots: exact("2"),
        ratePerSecond: exact("1/4"),
        fillSeconds: exact("3600"),
        verified: true,
      },
    ],
    ranches: [],
    kitchen: [],
    nutrientProcessors: exact("0"),
    pelletFeeders: exact("0"),
    noBuild: [],
    verified: true,
  };
}

/** Deficit the domain could size. */
const sizedBudget: PowerBudget = {
  base: "Sized Deficit",
  generation: exact("300"),
  draw: exact("450"),
  balance: exact("-150"),
  deficit: exact("150"),
  inDeficit: true,
  perGenerator: exact("50"),
  batteries: exact("0"),
  additionalGenerators: exact("3"),
  fixUnsized: false,
  verified: true,
};

/*
 * Deficit the domain could not size. Zero additional generators AND the flag
 * — the pair that reads as "nothing to show" without it.
 */
const unsizedBudget: PowerBudget = {
  base: "Unsized Deficit",
  generation: exact("200"),
  draw: exact("380"),
  balance: exact("-180"),
  deficit: exact("180"),
  inDeficit: true,
  perGenerator: exact("0"),
  batteries: exact("0"),
  additionalGenerators: exact("0"),
  fixUnsized: true,
  verified: true,
};

const surplusBudget: PowerBudget = {
  base: "Surplus",
  generation: exact("600"),
  draw: exact("450"),
  balance: exact("150"),
  deficit: exact("0"),
  inDeficit: false,
  perGenerator: exact("50"),
  batteries: exact("4"),
  additionalGenerators: exact("0"),
  fixUnsized: false,
  verified: true,
};

const root = document.getElementById("root");
if (!root) throw new Error("card-power.html is missing #root");

/* Exported so the module has one, which react-refresh asks of a file
 * declaring a component. */
export function Cards(): ReactNode {
  return (
    <>
      <BasePlannerCard
        base={baseNamed("Sized Deficit")}
        identity={1}
        budget={sizedBudget}
        configuration={{
          site: baseNamed("Sized Deficit").site,
          power: { emClass: "B", emGenerators: exact("2") },
        }}
        onConfigure={() => {}}
      />
      {/* No generator class configured — solar only, and no sized fix. */}
      <BasePlannerCard
        base={baseNamed("Unsized Deficit")}
        identity={2}
        budget={unsizedBudget}
        configuration={{
          site: baseNamed("Unsized Deficit").site,
          power: { solarPanels: exact("10") },
        }}
        onConfigure={() => {}}
      />
      <BasePlannerCard base={baseNamed("Surplus")} identity={3} budget={surplusBudget} />
    </>
  );
}

createRoot(root).render(
  <StrictMode>
    <Cards />
  </StrictMode>,
);
