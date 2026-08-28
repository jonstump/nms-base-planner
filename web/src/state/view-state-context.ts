import { createContext, type Dispatch } from "react";

import type { ViewAction, ViewState } from "./view-state";

/*
 * Governing: SPEC-0005 REQ "View State Boundaries"
 *
 * Two contexts, not one object. A component that only dispatches — every
 * button in the shell — then re-renders on nothing, because the dispatch
 * identity is stable for the life of the reducer.
 *
 * They live apart from the provider so that file exports only a component,
 * which is what lets Fast Refresh preserve state across an edit.
 */
export const StateContext = createContext<ViewState | null>(null);
export const DispatchContext = createContext<Dispatch<ViewAction> | null>(null);
