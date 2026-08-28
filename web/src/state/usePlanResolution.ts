import { useCallback, useEffect, useRef, useState } from "react";

import {
  BoundaryClient,
  validatePlan,
  type Failure,
  type ResolvedGraph,
} from "../boundary";
import { ResultCache } from "./result-cache";
import { crossingKey, type ViewState } from "./view-state";

/*
 * One crossing per set of inputs, held outside the view's state.
 *
 * Governing: ADR-0004 (React view layer), SPEC-0005 REQ "View State
 * Boundaries", REQ "Module Loading", REQ "The View Computes No Domain Values"
 *
 * The resolved graph is deliberately not in ViewState. It is a boundary
 * result cached against the inputs that produced it, and the cache holds one
 * entry — so an input change does not invalidate the old result so much as
 * leave it nowhere to be.
 *
 * `status` is what a component renders from. `pending` is a distinct state
 * from a zero and from a failure, per SPEC-0005: figures the module has not
 * produced yet are shown as pending, because a zero is a claim about the
 * plan and a pending is a claim about the module.
 */

export type Resolution =
  | { readonly status: "idle" }
  | { readonly status: "pending" }
  | { readonly status: "resolved"; readonly graph: ResolvedGraph }
  | { readonly status: "failed"; readonly outcome: Failure }
  /** The inputs are not a plan yet — an empty target, a half-typed quantity. */
  | { readonly status: "unusable"; readonly reason: string };

export interface PlanResolution {
  readonly resolution: Resolution;
  /**
   * Changes exactly when a new result arrives, and is null otherwise.
   * The live region announces on this and nothing else.
   */
  readonly resultToken: string | null;
  readonly recompute: () => void;
}

export function usePlanResolution(
  client: BoundaryClient,
  state: ViewState,
): PlanResolution {
  const cache = useRef(new ResultCache<ResolvedGraph>());
  const [resolution, setResolution] = useState<Resolution>({ status: "idle" });
  const [resultToken, setResultToken] = useState<string | null>(null);

  const key = crossingKey(state);
  const target = state.inputs.target;
  const quantity = state.inputs.quantity;

  /*
   * Guards against a slow answer to a superseded question. Two crossings in
   * flight resolve in whatever order the module finishes them, and without
   * this the first plan's graph can land after the second's and sit on
   * screen labelled with the second's inputs.
   */
  const latest = useRef(key);

  const run = useCallback(async () => {
    const validated = validatePlan({ target, quantity });
    if (!validated.ok) {
      setResolution({ status: "unusable", reason: validated.reason });
      setResultToken(null);
      return;
    }

    const requestKey = JSON.stringify([target, quantity]);
    latest.current = requestKey;

    const cached = cache.current.read(requestKey);
    if (cached) {
      setResolution({ status: "resolved", graph: cached });
      setResultToken(requestKey);
      return;
    }

    setResolution({ status: "pending" });

    const outcome = await client.resolve(validated.plan);
    if (latest.current !== requestKey) return;

    if (outcome.kind !== "ok") {
      setResolution({ status: "failed", outcome });
      setResultToken(null);
      return;
    }

    /*
     * write() returns the frozen value. Using the return rather than the
     * argument is what stops a component from holding the unfrozen original
     * and mutating it — which the cache exists to make impossible.
     */
    setResolution({
      status: "resolved",
      graph: cache.current.write(requestKey, outcome.value),
    });
    setResultToken(requestKey);
  }, [client, target, quantity]);

  /*
   * Not automatic on every keystroke: the target field is typed into a
   * character at a time, and each intermediate value is a plan the module
   * would answer UNKNOWN_ITEM to. Recompute is an explicit action, which is
   * also what makes the live-region announcement correspond to something the
   * user did.
   */
  const recompute = useCallback(() => {
    void run();
  }, [run]);

  useEffect(() => {
    /*
     * When the inputs move away from the cached result, the screen must stop
     * claiming that result describes them. It does not recompute — see above
     * — it goes back to idle.
     */
    if (cache.current.currentKey() !== null && cache.current.currentKey() !== key) {
      setResolution({ status: "idle" });
      setResultToken(null);
    }
  }, [key]);

  return { resolution, resultToken, recompute };
}
