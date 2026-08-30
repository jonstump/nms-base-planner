/*
 * The view's own state, and nothing else.
 *
 * Governing: ADR-0004 (React view layer), SPEC-0005 REQ "View State
 * Boundaries"
 *
 * "The view MUST hold only interface state: selection, section collapse,
 * form inputs, focus, and view-local preferences. It MUST NOT hold the plan,
 * the resolved graph, or any derived quantity as its own source of truth."
 *
 * The rule is kept by the shape of the type rather than by discipline. There
 * is no field a graph could be put in and no field a total could be put in,
 * so a component that wanted to cache a figure here would have to add one —
 * which is a diff a reviewer can see, unlike an assignment into a `data`
 * bag that was already there.
 *
 * `inputs` is the one that looks like an exception and is not. It holds the
 * characters in the form, exactly as typed, including the ones that are not
 * a valid quantity yet. That is form state; the plan is what validatePlan
 * makes of it at the moment of a crossing, and it is not kept.
 */

import { ENTRY_SURFACE, type SurfaceId } from "../shell/surfaces";

export interface ViewState {
  /**
   * Which surface is showing.
   *
   * Interface state, and the sixth key this type has ever had. SPEC-0011
   * REQ "Surfaces Are Shell View State" puts surface selection here rather
   * than in a router, and it is the same kind of thing as `selection`: what
   * the player is looking at, not what the domain computed.
   *
   * The shape test in tests/shell/view-state.spec.ts asserts the key set,
   * so this field arrived as a visible diff — which is what that test is
   * for. What it forbids is a field a plan, a graph or a derived quantity
   * could occupy, and a surface id is a closed union of two strings.
   */
  readonly surface: SurfaceId;

  /** Which node the user has selected, if any. */
  readonly selection: string | null;

  /** Section id → collapsed. Absent means expanded. */
  readonly collapsed: Readonly<Record<string, boolean>>;

  /** Raw form text. Not a Plan, and not validated until a crossing. */
  readonly inputs: {
    readonly target: string;
    readonly quantity: string;
  };

  /**
   * The element a popover should return focus to, by id.
   *
   * Focus is interface state and belongs here, but the *restoring* is the
   * focus trap's job — see src/a11y/useFocusTrap.ts. This records intent
   * across a re-render; it does not move focus.
   */
  readonly focusReturnTo: string | null;

  /** View-local, never sent anywhere. */
  readonly preferences: {
    /** Thousands separator for display. "" leaves digits ungrouped. */
    readonly groupSeparator: string;
    readonly showUnverified: boolean;
  };
}

export const INITIAL_VIEW_STATE: ViewState = Object.freeze({
  surface: ENTRY_SURFACE,
  selection: null,
  collapsed: Object.freeze({}),
  inputs: Object.freeze({ target: "", quantity: "1" }),
  focusReturnTo: null,
  preferences: Object.freeze({ groupSeparator: ",", showUnverified: true }),
});

export type ViewAction =
  | { readonly type: "selectSurface"; readonly surface: SurfaceId }
  | { readonly type: "select"; readonly nodeId: string | null }
  | { readonly type: "toggleCollapse"; readonly sectionId: string }
  | {
      readonly type: "setInput";
      readonly field: "target" | "quantity";
      readonly value: string;
    }
  | { readonly type: "setFocusReturn"; readonly elementId: string | null }
  | {
      readonly type: "setPreference";
      readonly field: "groupSeparator" | "showUnverified";
      readonly value: string | boolean;
    }
  /** Seeds the form from a shared link. Seeds the form — does not store the plan. */
  | { readonly type: "seedInputs"; readonly target: string; readonly quantity: string };

export function viewReducer(state: ViewState, action: ViewAction): ViewState {
  switch (action.type) {
    case "selectSurface":
      return { ...state, surface: action.surface };

    case "select":
      return { ...state, selection: action.nodeId };

    case "toggleCollapse":
      return {
        ...state,
        collapsed: {
          ...state.collapsed,
          [action.sectionId]: !state.collapsed[action.sectionId],
        },
      };

    case "setInput":
      return { ...state, inputs: { ...state.inputs, [action.field]: action.value } };

    case "setFocusReturn":
      return { ...state, focusReturnTo: action.elementId };

    case "setPreference":
      return {
        ...state,
        preferences: { ...state.preferences, [action.field]: action.value },
      };

    case "seedInputs":
      /*
       * Selection is cleared rather than carried. It names a node in the
       * previous graph, and the new plan's graph may not contain it — a
       * selection pointing at a node that is no longer there is a highlight
       * on nothing, or on the wrong thing.
       */
      return {
        ...state,
        inputs: { target: action.target, quantity: action.quantity },
        selection: null,
      };
  }
}

/**
 * A stable key for the inputs that feed a boundary call.
 *
 * Used to key the result cache. Anything the module's answer depends on has
 * to appear here, and nothing else may: a key including a view preference
 * would discard a perfectly good result when the user changed a separator.
 */
export function crossingKey(state: ViewState): string {
  return JSON.stringify([state.inputs.target, state.inputs.quantity]);
}
