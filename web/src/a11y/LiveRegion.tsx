import { LiveRegionContext } from "./live-region-context";

import { useCallback, useRef, useState, type ReactNode } from "react";

/*
 * The polite live region, and the rule that it announces recomputes rather
 * than renders.
 *
 * Governing: ADR-0004 (React view layer), SPEC-0005 Accessibility
 * Requirements
 *
 * "Every recompute MUST announce through an `aria-live="polite"` region ...
 * WHEN a user action causes domain figures to change THEN a polite live
 * region announces what changed and that totals updated."
 *
 * Issue #62 calls out the distinction a naive implementation conflates.
 * Announcing in a render — or in an effect with no dependency discipline —
 * fires on mount, on a preference change, on a parent re-render, and on
 * anything else React feels like doing. A screen reader user then hears
 * "totals updated" when nothing was computed, which is worse than silence:
 * it trains them to ignore the region.
 *
 * {@link useAnnounceOnChange} is the primitive that gets this right. It
 * tracks a token, skips the first value it ever sees, and speaks only when
 * the token actually changes.
 */

export function LiveRegionProvider({ children }: { children: ReactNode }): ReactNode {
  const [message, setMessage] = useState("");

  /*
   * The counter forces a DOM change even when the same sentence is announced
   * twice running. Assistive technology watches for a mutation, and setting
   * identical text produces none — so recomputing the same plan twice would
   * announce once.
   */
  const nonce = useRef(0);

  const announce = useCallback((next: string) => {
    nonce.current += 1;
    setMessage(nonce.current % 2 === 0 ? next : `${next} `);
  }, []);

  return (
    <LiveRegionContext.Provider value={{ announce }}>
      {children}
      {/*
        Visually hidden rather than display:none — a hidden region is not
        announced at all. aria-atomic so the whole sentence is read rather
        than the diff against the previous one.
      */}
      <div
        className="visually-hidden"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {message}
      </div>
    </LiveRegionContext.Provider>
  );
}
