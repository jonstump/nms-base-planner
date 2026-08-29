/*
 * The card under the provenance condition that actually holds.
 *
 * Governing: SPEC-0007 REQ "Provenance on Displayed Figures",
 * REQ "Duration Display", REQ "Absent Data Is Absent"
 *
 * `everything` marks every producer row and the base. That is not an edge
 * case: none of the curated constants carries a verified date, so this is
 * what the card renders against today. The requirement says the treatment
 * "MUST NOT rely on rarity for its restraint", and a fixture with one
 * marked row could never show whether it does.
 *
 * `mixed` is a verified base carrying one unverified row. It exists because
 * substituting either marker for the other is invisible in every other
 * arrangement: with both unverified, or both verified, a card that showed
 * only one of them would look correct.
 */

import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { asQuantity, type BaseBuild, type Quantity } from "../../src/boundary";
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

/** Every producer kind, so every duration the card can show is present. */
function baseWith(name: string, rowsVerified: boolean, baseVerified: boolean): BaseBuild {
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
        verified: rowsVerified,
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
        verified: rowsVerified,
      },
    ],
    ranches: [
      {
        itemId: "creaturepellets",
        name: "Livestock Unit",
        required: exact("60"),
        fauna: exact("4"),
        cycleSeconds: exact("900"),
        verified: rowsVerified,
      },
    ],
    kitchen: [
      {
        itemId: "cakeslice",
        name: "Cake Slice",
        recipe: "bake",
        required: exact("10"),
        processSeconds: exact("600"),
        final: true,
        verified: rowsVerified,
        inputs: [],
      },
    ],
    nutrientProcessors: exact("1"),
    pelletFeeders: exact("1"),
    noBuild: [
      {
        itemId: "condensedcarbon",
        name: "Condensed Carbon",
        from: "Gas refine byproduct",
        required: exact("200"),
        verified: rowsVerified,
      },
    ],
    verified: baseVerified,
  };
}

/* The state today: nothing confirmed, anywhere. */
const everything = baseWith("Everything Unverified", false, false);
/* A verified base whose row is not. Neither marker may stand in for the other. */
const mixed = baseWith("Mixed Provenance", false, true);

export function Cards(): ReactNode {
  return (
    <>
      <BasePlannerCard base={everything} identity={1} />
      <BasePlannerCard base={mixed} identity={2} />
    </>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("card-provenance.html is missing #root");

createRoot(root).render(
  <StrictMode>
    <Cards />
  </StrictMode>,
);
