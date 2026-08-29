import { useCallback, useRef, useState } from "react";

import type { Curated, Plan, RollupRequest } from "../boundary";

/*
 * Assignment in, recomputation out.
 *
 * Governing: ADR-0004 (React view layer), SPEC-0006 REQ "Leaf Assignment to
 * Bases", SPEC-0005 REQ "The View Computes No Domain Values", REQ "Boundary
 * Client"
 *
 * "Reassigning a leaf MUST cause the affected figures to be recomputed
 * through the boundary; the canvas MUST NOT adjust any base's totals
 * itself." This hook is where that is true or not — it holds the
 * assignments and every change to them issues stage 2, rather than editing
 * a figure a previous call returned.
 *
 * It goes through `client.rollup()` and adds no boundary method of its own,
 * which #88 requires and #95 is the reason for: two stories adding methods
 * to one client is the drift a foundation story exists to prevent. It also
 * does not reach past the boundary for the domain's rollup types, which
 * SPEC-0006 names as the tempting workaround and closes.
 *
 * `constants` is nullable, and that is the honest shape rather than a
 * convenience. `RollupRequest` requires curated constants; the application
 * has no source for them — they exist only in test fixtures, and the base
 * planner card is not mounted either — so today the shell passes null and
 * this hook holds assignments without dispatching. A fixture supplies real
 * constants and proves the dispatch. One code path, with the missing half
 * stated rather than hidden behind a stub.
 *
 * Out-of-order replies are dropped by sequence number, the way
 * usePlanResolution and useConfiguredBase both do it: two assignments in
 * flight settle in whatever order the module finishes them, and without
 * this the figures land from whichever call happened to be slower.
 */

interface AssignmentClient {
  readonly rollup: (request: RollupRequest) => Promise<unknown>;
}

export interface LeafAssignmentOptions {
  readonly client: AssignmentClient;
  readonly plan: Plan;
  /** Null until the application has a curated-constants source. */
  readonly constants: Curated | null;
}

export interface LeafAssignment {
  readonly assignments: Readonly<Record<string, string>>;
  /** Assign a leaf to a base, or pass null to clear it. */
  readonly assign: (itemId: string, baseId: string | null) => void;
  /** Settled stage-2 round trips this hook has dispatched. */
  readonly dispatches: number;
}

export function useLeafAssignment({
  client,
  plan,
  constants,
}: LeafAssignmentOptions): LeafAssignment {
  const [assignments, setAssignments] = useState<Readonly<Record<string, string>>>({});
  const [dispatches, setDispatches] = useState(0);
  const sequence = useRef(0);

  /*
   * The current map, readable synchronously.
   *
   * The dispatch happens in the handler rather than in an effect on
   * `assignments`, for two reasons. An effect cannot tell the first render
   * from a real change without a flag, and StrictMode double-invokes both
   * the effect and the flag — which is how a mount ends up issuing a rollup
   * for an empty map. And an effect that skipped the empty map to avoid
   * that would skip the *clear* as well, which is a real change: a leaf no
   * longer gathered at a base changes that base's totals exactly as
   * reassigning it does. The first version had that bug and a test found it.
   */
  const current = useRef<Readonly<Record<string, string>>>({});

  const assign = useCallback(
    (itemId: string, baseId: string | null) => {
      const previous = current.current;

      /*
       * Rebuilt without the key rather than set to undefined. An assignments
       * map carrying `{ COBALT: undefined }` serialises to a field the domain
       * has to interpret, and "assigned to nothing" is not in the contract.
       */
      const next: Readonly<Record<string, string>> =
        baseId === null
          ? Object.fromEntries(Object.entries(previous).filter(([key]) => key !== itemId))
          : { ...previous, [itemId]: baseId };

      if (baseId === null && !(itemId in previous)) return;
      if (baseId !== null && previous[itemId] === baseId) return;

      current.current = next;
      setAssignments(next);

      if (constants === null) return;

      const issued = sequence.current + 1;
      sequence.current = issued;

      const request: RollupRequest = { plan, assignments: next, constants };
      void client.rollup(request).then(() => {
        /*
         * What this hook owns is that the recompute was asked for. A
         * superseded assignment's reply is dropped rather than counted, the
         * way usePlanResolution and useConfiguredBase both do it.
         */
        if (sequence.current !== issued) return;
        setDispatches((count) => count + 1);
      });
    },
    [client, plan, constants],
  );

  return { assignments, assign, dispatches };
}
