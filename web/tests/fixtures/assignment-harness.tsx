import { createRoot } from "react-dom/client";
import { StrictMode, useEffect, useState, type ReactNode } from "react";

import type { Curated, Plan, RollupRequest } from "../../src/boundary";
import { useLeafAssignment } from "../../src/canvas/useLeafAssignment";

import "../../src/styles/tokens.css";
import "../../src/styles/base.css";

/*
 * The assignment hook, with the constants the application does not have.
 *
 * Governing: SPEC-0006 REQ "Leaf Assignment to Bases"
 *
 * "Reassigning a leaf MUST cause the affected figures to be recomputed
 * through the boundary." `RollupRequest` requires curated constants and the
 * application has no source for them, so the shell holds assignments and
 * dispatches nothing. This fixture supplies them, which is what makes the
 * dispatch observable at all — the same shape every SPEC-0007 card story
 * ships in, for the same reason.
 *
 * The client is a stand-in rather than the real boundary: what this proves
 * is that a change reaches `rollup` with the assignment on it, and the real
 * module's answer is not what the requirement is about. The captured
 * requests are exposed so a test can assert what crossed rather than that
 * something did.
 */

const CONSTANTS: Curated = {
  biodomeCropSlots: "4",
  faunaYieldPerCycle: "1",
  faunaCycleSeconds: "1800",
  stepsPerProcessor: "1",
  depotThreshold: "1000",
  processSeconds: "36",
  panelsPerBattery: "3",
} as Curated;

const PLAN: Plan = {
  target: "ANTIMATTER",
  quantity: "1",
  methods: {},
  recipes: {},
} as Plan;

declare global {
  interface Window {
    __assignment: {
      /** Every rollup request the hook issued, in order. */
      requests: () => RollupRequest[];
      dispatches: () => number;
    };
  }
}

const requests: RollupRequest[] = [];

function Harness(): ReactNode {
  const [client] = useState(() => ({
    rollup: async (request: RollupRequest): Promise<unknown> => {
      requests.push(request);
      return Promise.resolve({ kind: "ok" });
    },
  }));

  const { assignments, assign, dispatches } = useLeafAssignment({
    client,
    plan: PLAN,
    constants: CONSTANTS,
  });

  /*
   * Published from an effect rather than during render: assigning to a
   * global while rendering is a side effect, and React may render twice.
   */
  useEffect(() => {
    window.__assignment = {
      requests: () => requests,
      dispatches: () => dispatches,
    };
  }, [dispatches]);

  return (
    <main>
      <p data-dispatches={String(dispatches)}>dispatches: {dispatches}</p>
      <p data-assigned={assignments["COBALT"] ?? ""}>
        cobalt: {assignments["COBALT"] ?? "none"}
      </p>
      <button
        type="button"
        onClick={() => {
          assign("COBALT", "base-2");
        }}
      >
        assign cobalt
      </button>
      <button
        type="button"
        onClick={() => {
          assign("COBALT", "base-5");
        }}
      >
        reassign cobalt
      </button>
      <button
        type="button"
        onClick={() => {
          assign("COBALT", null);
        }}
      >
        clear cobalt
      </button>
    </main>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Harness />
    </StrictMode>,
  );
  document.body.dataset["ready"] = "true";
}
