/*
 * Renders the real card against a payload shaped like the boundary's.
 *
 * Governing: SPEC-0007 REQ "Card Composition From the Build Payload",
 * REQ "Producer Sections", REQ "Byproducts Are Shown, Not Omitted"
 *
 * The fixture builds a BaseBuild rather than reaching through the WASM
 * boundary: this suite is about what the card does with a payload, and
 * driving the engine to produce three kitchen steps at one base would test
 * the engine's scheduling as much as the card's rendering. The shape is the
 * boundary's own exported type, so a payload change that breaks the card
 * fails to compile here rather than passing against a private copy.
 *
 * `full` carries all four groups, three kitchen steps — the overcount case —
 * and a byproduct-covered demand. `sparse` carries one group and no identity
 * slot, which is the only way to tell an absent section from an empty one.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { asQuantity, type BaseBuild, type Quantity } from "../../src/boundary";
import { BasePlannerCard } from "../../src/card/BasePlannerCard";

import "../../src/styles/tokens.css";
import "../../src/styles/base.css";
import "../../src/styles/shell.css";
import "../../src/styles/card.css";

/** Exact strings in, exact strings out. A bad literal fails the fixture loudly. */
function exact(value: string): Quantity {
  const quantity = asQuantity(value);
  if (quantity === null) throw new Error(`fixture quantity is not exact: ${value}`);
  return quantity;
}

const full: BaseBuild = {
  base: "Verdant Shelf",
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
  ranches: [
    {
      itemId: "creaturepellets",
      name: "Livestock Unit",
      required: exact("60"),
      fauna: exact("4"),
      cycleSeconds: exact("900"),
      verified: true,
    },
  ],
  /* Three steps, one base. The count that must not be summed. */
  kitchen: [
    {
      itemId: "creamysauce",
      name: "Creamy Sauce",
      recipe: "milk",
      required: exact("30"),
      processSeconds: exact("300"),
      final: false,
      verified: true,
      inputs: [{ itemId: "milk", perOutput: exact("1") }],
    },
    {
      itemId: "sweetenedcream",
      name: "Sweetened Cream",
      recipe: "sugar",
      required: exact("20"),
      processSeconds: exact("300"),
      final: false,
      verified: true,
      inputs: [{ itemId: "creamysauce", perOutput: exact("1") }],
    },
    {
      itemId: "cakeslice",
      name: "Cake Slice",
      recipe: "bake",
      required: exact("10"),
      processSeconds: exact("600"),
      final: true,
      verified: true,
      inputs: [{ itemId: "sweetenedcream", perOutput: exact("2") }],
    },
  ],
  /* Base-level. Rendered once even though the kitchen carries three steps. */
  nutrientProcessors: exact("2"),
  pelletFeeders: exact("1"),
  noBuild: [
    {
      itemId: "condensedcarbon",
      name: "Condensed Carbon",
      from: "Gas refine byproduct",
      required: exact("200"),
      verified: true,
    },
  ],
  verified: true,
};

/* One group only, and no identity slot. */
const sparse: BaseBuild = {
  base: "Rime Outpost",
  site: { extractorClass: "A", fillSeconds: exact("1800") },
  farms: [],
  extractors: [
    {
      itemId: "cobalt",
      name: "Cobalt",
      class: "A",
      required: exact("500"),
      extractorCount: exact("1"),
      depots: exact("1"),
      ratePerSecond: exact("1/2"),
      fillSeconds: exact("1800"),
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

const root = document.getElementById("root");
if (!root) throw new Error("card.html is missing #root");

createRoot(root).render(
  <StrictMode>
    <BasePlannerCard base={full} identity={2} selected={true} />
    <BasePlannerCard base={sparse} />
  </StrictMode>,
);
