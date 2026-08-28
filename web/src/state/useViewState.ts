import { useContext, type Dispatch } from "react";

import { DispatchContext, StateContext } from "./view-state-context";
import type { ViewAction, ViewState } from "./view-state";

/*
 * Governing: SPEC-0005 REQ "View State Boundaries"
 *
 * The only way a component reaches view state. Both throw rather than
 * returning a default: a component rendered outside the provider would
 * otherwise silently read an initial state that nothing dispatches into, and
 * present a working screen that never changes.
 */

export function useViewState(): ViewState {
  const state = useContext(StateContext);
  if (!state) throw new Error("useViewState must be used inside a ViewStateProvider");
  return state;
}

export function useViewDispatch(): Dispatch<ViewAction> {
  const dispatch = useContext(DispatchContext);
  if (!dispatch)
    throw new Error("useViewDispatch must be used inside a ViewStateProvider");
  return dispatch;
}
