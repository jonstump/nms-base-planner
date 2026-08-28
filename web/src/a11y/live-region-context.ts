import { createContext } from "react";

/*
 * Governing: SPEC-0005 Accessibility Requirements
 *
 * The context alone, in its own module.
 *
 * React Fast Refresh only preserves state for a module that exports nothing
 * but components, so the provider, the context and the hooks are three files
 * rather than one. The alternative is losing every keystroke in the form on
 * each edit to the live region, which is a bad trade for one fewer file.
 */
export interface LiveRegionApi {
  /** Speak now. Use for direct results of a user action. */
  announce: (message: string) => void;
}

export const LiveRegionContext = createContext<LiveRegionApi | null>(null);
