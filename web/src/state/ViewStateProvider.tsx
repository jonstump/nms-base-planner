import { useMemo, useReducer, type ReactNode } from "react";

import { DispatchContext, StateContext } from "./view-state-context";
import { INITIAL_VIEW_STATE, viewReducer, type ViewState } from "./view-state";

/*
 * Governing: ADR-0004 (React view layer), SPEC-0005 REQ "View State
 * Boundaries"
 *
 * ADR-0004 left the state library open, recommending useReducer plus context
 * or Zustand and reserving Redux Toolkit for a concrete need. This story was
 * told to settle it on the evidence of the first working slice.
 *
 * It is useReducer plus context, and the reason is that the interesting
 * state is not here. Every domain value lives in Go and arrives through one
 * boundary call; the view holds a selection, some collapse flags, two form
 * fields and two preferences. That is a handful of scalars with no
 * cross-cutting async, no normalised entity graph and no derived-selector
 * layer — which is the entire problem Zustand and Redux Toolkit exist to
 * solve.
 *
 * The one argument for Redux worth keeping in view — ADR-0004 records it —
 * is that time-travel devtools help when debugging a boundary you cannot
 * step through. It does not apply here. The boundary is a pure function of
 * the plan: replaying an action sequence tells you nothing that re-issuing
 * one `resolve` with the same plan does not, and the plan is in the URL hash
 * already.
 *
 * If a later surface grows a normalised cache — the bases map is the
 * candidate — this is a contained swap. Components read through the two
 * hooks in useViewState.ts and none of them knows what is behind them.
 */
export function ViewStateProvider({
  children,
  initial = INITIAL_VIEW_STATE,
}: {
  readonly children: ReactNode;
  readonly initial?: ViewState;
}): ReactNode {
  const [state, dispatch] = useReducer(viewReducer, initial);
  const memoState = useMemo(() => state, [state]);

  return (
    <StateContext.Provider value={memoState}>
      <DispatchContext.Provider value={dispatch}>{children}</DispatchContext.Provider>
    </StateContext.Provider>
  );
}
