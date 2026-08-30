import { useEffect, useRef, useState } from "react";

import type { BoundaryClient, CatalogueItem } from "../boundary";

/*
 * The item catalogue, fetched once.
 *
 * Governing: ADR-0004 (React view layer), SPEC-0011 REQ "The Catalogue
 * Crosses the Boundary", REQ "Target Selection Is a Search Over Known
 * Items", § Rate Limiting, SPEC-0005 REQ "Module Loading"
 *
 * Once, not per keystroke. SPEC-0011 § Rate Limiting is explicit that "the
 * search MUST NOT issue a catalogue call per keystroke", and the list does
 * not change while the page is open — the artifact is loaded once and the
 * catalogue is a projection of it.
 *
 * The retry is the readiness contract, not a general one. SPEC-0011: "WHEN
 * the catalogue is requested before the module is ready THEN the view
 * presents a loading state and retries once readiness resolves, rather than
 * reporting an error." So a NOT_READY answer waits for readiness and asks
 * again; anything else is a real failure and is reported as one.
 */

export type CatalogueState =
  /** Asked, and waiting. Not an error, and not an empty list. */
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly items: readonly CatalogueItem[] }
  /** The module answered, and it was not a readiness problem. */
  | { readonly status: "failed"; readonly reason: string };

const LOADING: CatalogueState = Object.freeze({ status: "loading" });

async function fetchCatalogue(client: BoundaryClient): Promise<CatalogueState> {
  const outcome = await client.catalogue();
  if (outcome.kind === "ok") return { status: "ready", items: outcome.value };

  /*
   * A version mismatch is never retried. This story bumps the contract to
   * add the entry point, so a view built against 1.4.0 against an older
   * module is exactly the skew SPEC-0002's mismatch rule exists for — the
   * answer is to report it, not to ask a module that does not carry the
   * entry point a second time.
   */
  if (outcome.kind === "version-mismatch") {
    return { status: "failed", reason: outcome.message };
  }

  /*
   * NOT_READY is the module saying "ask again", which is what `start`
   * waits for. Every other code is something going wrong, and retrying it
   * would loop.
   */
  if (outcome.code !== "NOT_READY") {
    return { status: "failed", reason: outcome.message };
  }

  await client.start();
  const second = await client.catalogue();
  return second.kind === "ok"
    ? { status: "ready", items: second.value }
    : { status: "failed", reason: second.message };
}

export function useCatalogue(client: BoundaryClient): CatalogueState {
  const [state, setState] = useState<CatalogueState>(LOADING);

  /*
   * The in-flight promise, not a "have I asked" flag.
   *
   * A boolean guard deadlocks under StrictMode: the first effect starts the
   * fetch, its cleanup marks the result unwanted, and the second effect
   * sees the flag already set and never fetches — so nothing ever settles
   * and the control sits on its loading state forever. Caching the promise
   * gives one crossing and lets every mount subscribe to it.
   */
  const pending = useRef<Promise<CatalogueState> | null>(null);

  useEffect(() => {
    let live = true;
    pending.current ??= fetchCatalogue(client);
    void pending.current.then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, [client]);

  return state;
}
