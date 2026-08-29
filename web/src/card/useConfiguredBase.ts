import { useCallback, useEffect, useRef, useState } from "react";

import type { Curated, PowerRequest, RollupRequest } from "../boundary";

import type { CardConfiguration } from "./configuration";

/*
 * Configuration in, recomputation out.
 *
 * Governing: ADR-0004 (React view layer), SPEC-0007 REQ "Site Configuration",
 * REQ "Power Configuration Supports Mixed Sources", SPEC-0005 REQ "The View
 * Computes No Domain Values", REQ "Boundary Client"
 *
 * SPEC-0007: "Changing either MUST recompute through the boundary. The card
 * MUST NOT adjust counts, fill times or power draw itself." This hook is
 * where that is true or not — it holds the configuration, and every change
 * to it issues stage 2 and stage 3 calls rather than editing a figure the
 * previous call returned.
 *
 * Both stages go out together on every change, and neither is skipped on the
 * grounds that a change "only affects" one of them. The extractor class
 * resizes extractor counts (stage 2) and their draw (stage 3); a generator
 * count moves generation (stage 3) while leaving the build alone. Deciding
 * per-field which stage to re-run would be the view reasoning about the
 * domain's dependency graph, and getting it wrong shows up as a stale figure
 * rather than as an error.
 *
 * Out-of-order completion is handled the way usePlanResolution handles it:
 * each dispatch takes a sequence number and a late reply for a superseded
 * configuration is dropped. Without it, typing in the fill-duration entry
 * settles on whichever call the module happened to finish last.
 */

export interface ConfiguredBase {
  readonly configuration: CardConfiguration;
  readonly configure: (next: CardConfiguration) => void;
  /** How many boundary round-trips this hook has dispatched. */
  readonly dispatches: number;
}

/*
 * Only the two stages this hook issues.
 *
 * Narrower than BoundaryClient on purpose: the hook needs no readiness, no
 * subscription and no resolve, and depending on the whole client would make
 * it untestable without a running WASM module. `BoundaryClient` satisfies
 * this structurally, so production passes the real one and nothing adapts.
 */
export interface RecomputeClient {
  rollup: (request: RollupRequest) => Promise<unknown>;
  power: (request: PowerRequest) => Promise<unknown>;
}

export interface ConfiguredBaseOptions {
  readonly client: RecomputeClient;
  readonly base: string;
  readonly initial: CardConfiguration;
  readonly constants: Curated;
  /** The plan stage 2 is computed against. */
  readonly plan: RollupRequest["plan"];
}

export function useConfiguredBase({
  client,
  base,
  initial,
  constants,
  plan,
}: ConfiguredBaseOptions): ConfiguredBase {
  const [configuration, setConfiguration] = useState<CardConfiguration>(initial);
  const [dispatches, setDispatches] = useState(0);
  const sequence = useRef(0);

  const configure = useCallback((next: CardConfiguration) => {
    setConfiguration(next);
  }, []);

  useEffect(() => {
    const issued = sequence.current + 1;
    sequence.current = issued;

    const rollup: RollupRequest = {
      plan,
      sites: { [base]: configuration.site },
      constants,
    };
    const power: PowerRequest = {
      sources: { [base]: configuration.power },
      constants,
    };

    let live = true;
    void Promise.all([client.rollup(rollup), client.power(power)]).then(() => {
      /*
       * The results are the caller's to render; what this hook owns is the
       * guarantee that they were asked for. A superseded configuration's
       * reply is dropped rather than counted, so `dispatches` tracks
       * settled current calls and not every keystroke in flight.
       */
      if (!live || sequence.current !== issued) return;
      setDispatches((count) => count + 1);
    });

    return () => {
      live = false;
    };
  }, [client, base, configuration, constants, plan]);

  return { configuration, configure, dispatches };
}
