import { useEffect, useRef, useState } from "react";

import { fetchCurated, type Curated, type Failure } from "../boundary";

/*
 * The Tier 2 curated constants, fetched once.
 *
 * Governing: ADR-0001 (two-tier ingestion — Tier 2 is hand-maintained),
 * ADR-0004 (React view layer), SPEC-0005 REQ "Module Loading"
 *
 * Once, and after the paint. The file is small and never changes while the
 * page is open, so a second fetch could only produce the same answer — and
 * the effect it runs in is what keeps it off the first-paint waterfall,
 * the same argument the WASM module gets.
 *
 * Not fetched by `BoundaryModule`, deliberately. The module's load has two
 * failure modes it is careful to keep apart, and this would be a third that
 * means something different again: the module is fine, the graph resolves,
 * and no producer can be sized. Folding it in would make "the planner
 * failed to load" the message for a typo in a hand-edited file.
 *
 * Nothing retries. A module answering NOT_READY is saying "ask again",
 * which is why useCatalogue retries; a static file that 404s or does not
 * parse will 404 or fail to parse the second time too.
 */

export type CuratedState =
  /** Asked, and waiting. Not "there are no constants". */
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly constants: Curated }
  /** The file did not arrive, or arrived and did not check out. */
  | { readonly status: "failed"; readonly reason: string; readonly outcome: Failure };

const LOADING: CuratedState = Object.freeze({ status: "loading" });

async function load(path: string | undefined): Promise<CuratedState> {
  const outcome = await fetchCurated(path);
  return outcome.kind === "ok"
    ? { status: "ready", constants: outcome.value }
    : { status: "failed", reason: outcome.message, outcome };
}

export function useCurated(path?: string): CuratedState {
  const [state, setState] = useState<CuratedState>(LOADING);

  /*
   * The in-flight promise rather than a "have I asked" flag, for the reason
   * useCatalogue spells out: under StrictMode a boolean guard is set by the
   * first effect and seen by the second, so the fetch is started once and
   * its result thrown away, and nothing ever settles.
   */
  const pending = useRef<Promise<CuratedState> | null>(null);

  useEffect(() => {
    let live = true;
    pending.current ??= load(path);
    void pending.current.then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, [path]);

  return state;
}

/** The constants themselves, or null while they are not available. */
export function constantsOf(state: CuratedState): Curated | null {
  return state.status === "ready" ? state.constants : null;
}
