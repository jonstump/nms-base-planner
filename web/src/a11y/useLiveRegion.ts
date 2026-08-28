import { useContext, useEffect, useRef } from "react";

import { LiveRegionContext, type LiveRegionApi } from "./live-region-context";

export function useLiveRegion(): LiveRegionApi {
  const api = useContext(LiveRegionContext);
  if (!api) throw new Error("useLiveRegion must be used inside a LiveRegionProvider");
  return api;
}

/**
 * Announce when `token` changes, and never on first render.
 *
 * `token` identifies the computation, not the message: pass something that
 * changes exactly when a new boundary result arrives. The message is built
 * lazily so a render that is not going to announce does not pay to describe
 * something nobody will hear.
 */
export function useAnnounceOnChange(token: string | null, describe: () => string): void {
  const { announce } = useLiveRegion();

  /*
   * Seeded with a value no token can equal, so the first real token is a
   * change from "nothing seen yet" — and then suppressed explicitly below.
   * The two-step is what separates "first render" from "changed to null".
   */
  const previous = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const first = previous.current === undefined;
    const changed = previous.current !== token;
    previous.current = token;

    if (first || !changed || token === null) return;
    announce(describe());
    // `describe` is intentionally not a dependency: it is rebuilt every
    // render, and including it would announce on every render — which is the
    // exact bug this hook exists to prevent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, announce]);
}
