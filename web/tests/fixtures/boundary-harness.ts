/*
 * Test harness for the boundary client.
 *
 * Governing: SPEC-0005 REQ "Module Loading", REQ "Boundary Client"
 *
 * Deliberately does not start the module. The first thing the lazy-load test
 * checks is that a page can paint and respond without the WASM binary having
 * been asked for, and a harness that loaded it on import would make that
 * unmeasurable.
 */

import {
  BoundaryClient,
  decodePlanFromHash,
  formatQuantity,
  validatePlan,
} from "../../src/boundary";
import type { ModulePaths, Plan } from "../../src/boundary";

const client = new BoundaryClient();

declare global {
  interface Window {
    __boundary: {
      peek: () => ReturnType<BoundaryClient["peek"]>;
      start: () => Promise<void>;
      resolve: (plan: unknown) => Promise<unknown>;
      /** Issue a resolve without awaiting it, so a test can observe pending. */
      resolveLater: (plan: unknown) => void;
      settled: () => unknown;
      decodeHash: typeof decodePlanFromHash;
      format: typeof formatQuantity;
      /*
       * A second client pointed at tests/fixtures/fake, for the branches a
       * healthy module never takes: a wrong contract version, an artifact
       * that fails to validate, a binary that will not load.
       */
      withPaths: (paths: ModulePaths) => {
        peek: () => ReturnType<BoundaryClient["peek"]>;
        start: () => Promise<void>;
        resolve: (plan: unknown) => Promise<unknown>;
      };
    };
    /** Read by tests/fixtures/fake/shim.js to script the stand-in module. */
    __fake?: {
      contractVersion?: string;
      loadFails?: boolean;
      notReadyTimes?: number;
      neverPublish?: boolean;
    };
  }
}

let pending: Promise<unknown> | null = null;
let settled: unknown = null;

function plan(value: unknown): Plan {
  const result = validatePlan(value);
  if (!result.ok) throw new Error(`the test supplied an invalid plan: ${result.reason}`);
  return result.plan;
}

window.__boundary = {
  peek: () => client.peek(),
  start: () => client.start(),
  resolve: async (value) => client.resolve(plan(value)),
  resolveLater: (value) => {
    pending = client.resolve(plan(value)).then((outcome) => {
      settled = outcome;
      return outcome;
    });
    void pending;
  },
  settled: () => settled,
  decodeHash: decodePlanFromHash,
  format: formatQuantity,
  withPaths: (paths) => {
    const scoped = BoundaryClient.withPaths(paths);
    return {
      peek: () => scoped.peek(),
      start: () => scoped.start(),
      resolve: async (value) => scoped.resolve(plan(value)),
    };
  },
};

/* A control that works without the module, so "interactive while loading" is
 * something a test can press rather than something the source claims. */
const button = document.querySelector<HTMLButtonElement>("#counter");
if (button) {
  let count = 0;
  button.addEventListener("click", () => {
    count += 1;
    button.textContent = `clicked ${String(count)}`;
  });
}

document.body.dataset["painted"] = "true";
