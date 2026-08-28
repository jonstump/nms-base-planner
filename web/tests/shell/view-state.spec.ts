import { expect, test } from "@playwright/test";

import { ResultCache } from "../../src/state/result-cache";
import {
  INITIAL_VIEW_STATE,
  crossingKey,
  viewReducer,
  type ViewAction,
  type ViewState,
} from "../../src/state/view-state";

/*
 * Governing: ADR-0004 (React view layer), SPEC-0005 REQ "View State
 * Boundaries"
 *
 * "WHEN the view's state is inspected after a plan is resolved THEN it holds
 * selection, collapse, inputs and focus, and no independent copy of the plan
 * or its derived figures."
 *
 * Tested against the reducer rather than through the rendered app, because
 * the claim is about every reachable state and not about the ones a click
 * sequence happens to visit.
 */

function apply(actions: ViewAction[], from: ViewState = INITIAL_VIEW_STATE): ViewState {
  return actions.reduce(viewReducer, from);
}

/** Every string anywhere in the state, however nested. */
function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value as Record<string, unknown>))
      allStrings(entry, out);
  }
  return out;
}

test("the state's shape has nowhere to put a plan or a graph", () => {
  /*
   * The requirement is kept by the type, so the check is on the keys. A
   * field added to hold a graph would fail here rather than being noticed in
   * review, or not.
   */
  expect(Object.keys(INITIAL_VIEW_STATE).sort()).toEqual([
    "collapsed",
    "focusReturnTo",
    "inputs",
    "preferences",
    "selection",
  ]);
});

test("no reachable state holds a derived figure", () => {
  const busy = apply([
    { type: "setInput", field: "target", value: "ULTRAPROD2" },
    { type: "setInput", field: "quantity", value: "3" },
    { type: "select", nodeId: "ALLOY1" },
    { type: "toggleCollapse", sectionId: "raws" },
    { type: "setFocusReturn", elementId: "node-ALLOY1" },
    { type: "setPreference", field: "showUnverified", value: false },
  ]);

  /*
   * The only strings in view state are ones the user typed or ids the view
   * chose. A rational — the shape only the domain produces — appearing here
   * would mean a figure had been copied in.
   */
  for (const text of allStrings(busy)) {
    expect(text, `${text} looks like a domain quantity`).not.toMatch(/^\d+\/\d+$/);
  }

  expect(JSON.stringify(busy)).not.toContain("nodes");
  expect(JSON.stringify(busy)).not.toContain("gameVersion");
});

test("seeding from a shared link seeds the form, and does not store the plan", () => {
  const seeded = apply([{ type: "seedInputs", target: "ULTRAPROD2", quantity: "2" }]);

  expect(seeded.inputs).toEqual({ target: "ULTRAPROD2", quantity: "2" });
  expect(Object.keys(seeded).sort()).toEqual(Object.keys(INITIAL_VIEW_STATE).sort());
});

test("seeding clears a selection that named a node in the previous graph", () => {
  const seeded = apply([
    { type: "select", nodeId: "ALLOY1" },
    { type: "seedInputs", target: "ANTIMATTER", quantity: "1" },
  ]);
  expect(seeded.selection).toBeNull();
});

test("the crossing key covers the inputs the module sees, and nothing else", () => {
  const base = apply([
    { type: "setInput", field: "target", value: "ULTRAPROD2" },
    { type: "setInput", field: "quantity", value: "1" },
  ]);

  const quantityChanged = viewReducer(base, {
    type: "setInput",
    field: "quantity",
    value: "2",
  });
  expect(crossingKey(quantityChanged)).not.toBe(crossingKey(base));

  /*
   * A preference is not an input to the module. Including one in the key
   * would throw away a perfectly good result because somebody changed a
   * thousands separator.
   */
  const preferenceChanged = viewReducer(base, {
    type: "setPreference",
    field: "groupSeparator",
    value: " ",
  });
  expect(crossingKey(preferenceChanged)).toBe(crossingKey(base));

  const selectionChanged = viewReducer(base, { type: "select", nodeId: "ALLOY1" });
  expect(crossingKey(selectionChanged)).toBe(crossingKey(base));
});

test.describe("the result cache", () => {
  test("a changed input discards the result rather than adjusting it", () => {
    const cache = new ResultCache<{ total: string }>();
    cache.write('["ULTRAPROD2","1"]', { total: "1" });

    expect(cache.read('["ULTRAPROD2","1"]')).toEqual({ total: "1" });
    expect(cache.read('["ULTRAPROD2","2"]')).toBeNull();

    cache.write('["ULTRAPROD2","2"]', { total: "2" });

    /*
     * The old entry is gone, not superseded-but-present. One slot is what
     * makes "which of these is current" unaskable.
     */
    expect(cache.read('["ULTRAPROD2","1"]')).toBeNull();
    expect(cache.currentKey()).toBe('["ULTRAPROD2","2"]');
  });

  test("a cached result cannot be edited in place", () => {
    const cache = new ResultCache<{ nodes: { total: string }[] }>();
    const stored = cache.write('["X","1"]', { nodes: [{ total: "1" }] });

    /*
     * Frozen deeply, and asserted at depth. A shallow freeze would leave the
     * node objects writable, which is exactly where a component would be
     * tempted to adjust a total rather than re-cross.
     */
    expect(() => {
      "use strict";
      (stored.nodes[0] as { total: string }).total = "2";
    }).toThrow();

    expect(stored.nodes[0]?.total).toBe("1");
  });

  test("the value handed back is the frozen one, not the caller's object", () => {
    /*
     * write() returning the frozen value is what stops a caller keeping the
     * original — which is still mutable, and would defeat the freeze
     * entirely.
     */
    const cache = new ResultCache<{ total: string }>();
    const original = { total: "1" };
    const stored = cache.write('["X","1"]', original);

    expect(Object.isFrozen(stored)).toBe(true);
    expect(stored).toBe(original);
  });
});
