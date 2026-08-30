/*
 * The card with its controls, wired to a boundary client that records calls.
 *
 * Governing: SPEC-0007 REQ "Site Configuration", REQ "Power Configuration
 * Supports Mixed Sources", SPEC-0005 REQ "The View Computes No Domain Values"
 *
 * The acceptance criterion is that every configuration change issues a
 * boundary call, which is a claim about what the card *asks for* rather than
 * about what it renders. A real WASM module would answer, but it would also
 * make the assertion depend on the engine agreeing — so the client here is a
 * stub that records requests and returns a fixed payload. What is under test
 * is the card's side of the contract.
 *
 * The stub returns the same budget every time on purpose: if the card were
 * adjusting figures itself, the rendered battery count would drift away from
 * the payload's while the stub kept answering the same thing.
 */

import { StrictMode, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import {
  asQuantity,
  EMPTY_PLAN,
  type BaseBuild,
  type Curated,
  type PowerBudget,
  type PowerRequest,
  type Quantity,
  type RollupRequest,
} from "../../src/boundary";
import { BasePlannerCard } from "../../src/card/BasePlannerCard";
import {
  useConfiguredBase,
  type RecomputeClient,
} from "../../src/card/useConfiguredBase";

import "../../src/styles/tokens.css";
import "../../src/styles/base.css";
import "../../src/styles/shell.css";
import "../../src/styles/card.css";

function exact(value: string): Quantity {
  const quantity = asQuantity(value);
  if (quantity === null) throw new Error(`fixture quantity is not exact: ${value}`);
  return quantity;
}

const base: BaseBuild = {
  base: "Verdant Shelf",
  site: { extractorClass: "C", fillSeconds: exact("3600") },
  farms: [],
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
    {
      itemId: "cobalt",
      name: "Cobalt",
      class: "C",
      required: exact("400"),
      extractorCount: exact("1"),
      depots: exact("1"),
      ratePerSecond: exact("1/2"),
      fillSeconds: exact("3600"),
      verified: true,
    },
    {
      itemId: "ferrite",
      name: "Ferrite Dust",
      class: "C",
      required: exact("900"),
      extractorCount: exact("2"),
      depots: exact("1"),
      ratePerSecond: exact("1/3"),
      fillSeconds: exact("3600"),
      verified: true,
    },
  ],
  ranches: [],
  kitchen: [],
  nutrientProcessors: exact("0"),
  pelletFeeders: exact("0"),
  noBuild: [],
  configured: true,
  unsited: [],
  verified: true,
};

const budget: PowerBudget = {
  base: "Verdant Shelf",
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

const constants: Curated = {
  biodomeCropSlots: exact("12"),
  faunaYieldPerCycle: exact("3"),
  faunaCycleSeconds: exact("900"),
  stepsPerProcessor: exact("3"),
  depotThreshold: exact("1000"),
  processSeconds: exact("300"),
  panelsPerBattery: exact("3"),
};

/*
 * A client that records rather than computes.
 *
 * The hook under test is the one that turns a configuration change into
 * stage 2 and stage 3 calls, so what a real module would answer is beside
 * the point — and depending on one would make this suite need a running
 * WASM build to assert a call was issued. `RecomputeClient` is the narrow
 * shape the hook actually needs, which is why a stub is three lines.
 */
const calls: { rollup: RollupRequest[]; power: PowerRequest[] } = {
  rollup: [],
  power: [],
};

const recorder: RecomputeClient = {
  rollup: (request) => {
    calls.rollup.push(request);
    return Promise.resolve(null);
  },
  power: (request) => {
    calls.power.push(request);
    return Promise.resolve(null);
  },
};

export function Harness(): ReactNode {
  const { configuration, configure } = useConfiguredBase({
    client: recorder,
    base: base.base,
    initial: { site: base.site, power: { emClass: "C" } },
    constants,
    plan: EMPTY_PLAN,
  });

  /*
   * Published in an effect, not during render. Writing to the document while
   * rendering is a side effect in the render body, which React forbids and
   * eslint's react-hooks/immutability rule catches.
   *
   * The counts include the hook's mount-time call. That call is correct — an
   * initial configuration has to be computed before anything is shown — so
   * the tests read a baseline and assert it moves, rather than assuming the
   * first change is the first call.
   */
  useEffect(() => {
    document.body.dataset["rollupCalls"] = String(calls.rollup.length);
    document.body.dataset["powerCalls"] = String(calls.power.length);
    document.body.dataset["lastExtractorClass"] = configuration.site.extractorClass;
    document.body.dataset["lastSolarPanels"] = configuration.power.solarPanels ?? "";
  }, [configuration]);

  return (
    <BasePlannerCard
      base={base}
      identity={2}
      configuration={configuration}
      budget={budget}
      onConfigure={configure}
    />
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("card-config.html is missing #root");

createRoot(root).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
