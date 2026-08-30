/*
 * The store's first consumer.
 *
 * Governing: ADR-0008 (durable user data), SPEC-0009 REQ "View Preferences
 * Survive a Reload", REQ "An Empty Store Is a Designed State"
 *
 * The line this hook must not cross, in the words of the story that asked
 * for it: persisting preferences MUST NOT move them out of view state. They
 * remain interface state the view owns, and the store is where the view's
 * own copy is written and read.
 *
 * That is not a stylistic preference. `ViewState` having no field a graph
 * could go in is the thing that has kept graphs out of it, and a store
 * wired in as a general state container is the back door those rules were
 * keeping shut. So this hook only ever dispatches `setPreference` — the
 * action that already existed — and holds its own bookkeeping in local
 * component state, where it cannot be mistaken for shared view state.
 *
 * Nothing here reads or writes a plan, a resolved graph, or a derived
 * quantity, and `ViewState` gains no field.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { DurableStore } from "../store";
import type { PlaceRecord } from "../store";
import { differ, fromStored, toStored, type Preferences } from "./preferences";
import { useViewDispatch, useViewState } from "./useViewState";
import { INITIAL_VIEW_STATE } from "./view-state";

export type StoreStatus =
  /** The first read has not finished. Not empty, and not a failure. */
  | "loading"
  /** Read, and usable. `places` may still be empty — that is a state, not a fault. */
  | "ready"
  /** IndexedDB is blocked or absent: a private window, or a disabled API. */
  | "unavailable";

export interface StoredData {
  readonly status: StoreStatus;
  readonly places: readonly PlaceRecord[];
  /**
   * Read, and held nothing.
   *
   * False while loading, which matters: an empty state rendered before the
   * read finishes would flash "nothing saved" at a player who has data, and
   * that reads as loss rather than as latency.
   */
  readonly empty: boolean;
  /**
   * A write has been issued and has not settled.
   *
   * Exposed because a write that can be lost is not persistence. The first
   * draft issued `putPreferences` and dropped the promise, and a reload
   * arriving before the transaction committed lost the change — found by
   * the test that toggles two preferences and reloads at once, which is
   * also exactly what a player does when they set something and leave.
   */
  readonly saving: boolean;
  /**
   * Remove everything the store holds.
   *
   * Governing: SPEC-0009 REQ "Deletion Is a First-Class Operation". The
   * confirmation is the caller's — this is the operation, not the prompt.
   */
  readonly deleteEverything: () => Promise<void>;
  /**
   * Create a place from a name and nothing else.
   *
   * Governing: ADR-0010 (places are authored first), SPEC-0011 REQ "A Place
   * Is Creatable by Hand" — "The minimum a place requires before a plan may
   * assign to it is its generated `id` and a name. Every other field ... MUST
   * be optional at creation."
   *
   * The id is generated here and is the only identifier the place ever has:
   * ADR-0010 makes it the value the domain receives as `BaseID`, so minting
   * a second one for the plan to use is the thing SPEC-0011 forbids.
   *
   * `kind` defaults to "base" rather than being asked for. A freighter and a
   * settlement are places too (SPEC-0009 REQ "A Place Is One Record Type"),
   * but making the player answer that before they can have one is exactly the
   * longer first-run path the requirement rules out.
   */
  readonly createPlace: (name: string) => Promise<void>;
  /**
   * Remove one place.
   *
   * Governing: ADR-0010 (a deleted place unassigns; it does not cascade),
   * SPEC-0011 REQ "An Assignment Naming an Absent Place Is Unassigned"
   *
   * No plan is touched. Leaves that named this place become unassigned by
   * rule when the plan is next read against the workspace — see
   * canvas/assignments.ts.
   */
  readonly removePlace: (id: string) => Promise<void>;
}

const NOOP = async (): Promise<void> => {
  /* replaced by the real operation once the hook has run */
};

const NOOP_WITH_ARG = async (): Promise<void> => {
  /* replaced by the real operation once the hook has run */
};

const LOADING: StoredData = Object.freeze({
  status: "loading",
  places: Object.freeze([]),
  empty: false,
  saving: false,
  deleteEverything: NOOP,
  createPlace: NOOP_WITH_ARG,
  removePlace: NOOP_WITH_ARG,
});

export function useStoredData(store: DurableStore): StoredData {
  const { preferences } = useViewState();
  const dispatch = useViewDispatch();
  const [data, setData] = useState<StoredData>(LOADING);
  const [saving, setSaving] = useState(false);

  /*
   * Writes are chained rather than issued concurrently. Two readwrite
   * transactions on one object store are ordered by the spec, but the
   * chain also gives the outstanding count something to hang off, and it
   * makes the ordering a property of this file rather than of a spec
   * paragraph a reader would have to go and find.
   */
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const outstanding = useRef(0);

  /*
   * What was last seen, so the restore does not immediately write itself
   * back and so an unchanged preference writes nothing at all.
   */
  const written = useRef<Preferences | null>(null);

  useEffect(() => {
    let live = true;

    const restore = async (): Promise<void> => {
      const opened = await store.open();
      if (!live) return;
      if (opened.kind !== "ok") {
        setData({
          status: "unavailable",
          places: [],
          empty: false,
          saving: false,
          deleteEverything: NOOP,
          createPlace: NOOP_WITH_ARG,
          removePlace: NOOP_WITH_ARG,
        });
        return;
      }

      const loaded = await store.load();
      if (!live) return;
      if (loaded.kind !== "ok") {
        setData({
          status: "unavailable",
          places: [],
          empty: false,
          saving: false,
          deleteEverything: NOOP,
          createPlace: NOOP_WITH_ARG,
          removePlace: NOOP_WITH_ARG,
        });
        return;
      }

      const restored = fromStored(loaded.value.workspace.preferences);
      written.current = restored;

      /*
       * Dispatched field by field through the action that already exists,
       * rather than through a new "replace preferences" action. A bulk
       * setter would be the natural place for a later caller to pass
       * something that is not a preference.
       */
      dispatch({
        type: "setPreference",
        field: "groupSeparator",
        value: restored.groupSeparator,
      });
      dispatch({
        type: "setPreference",
        field: "showUnverified",
        value: restored.showUnverified,
      });

      setData({
        status: "ready",
        places: loaded.value.places,
        empty: loaded.value.places.length === 0,
        saving: false,
        deleteEverything: NOOP,
        createPlace: NOOP_WITH_ARG,
        removePlace: NOOP_WITH_ARG,
      });
    };

    void restore();
    return () => {
      live = false;
    };
  }, [store, dispatch]);

  useEffect(() => {
    /*
     * Nothing is written until the restore has happened. Without this the
     * first render would persist the *initial* preferences over whatever
     * the player had saved — the bug where a setting resets itself on every
     * load and looks like the store failing to read.
     */
    const last = written.current;
    if (last === null || !differ(last, preferences)) return;

    written.current = preferences;
    outstanding.current += 1;
    setSaving(true);

    queue.current = queue.current.then(() => store.putPreferences(toStored(preferences)));
    void queue.current.finally(() => {
      outstanding.current -= 1;
      if (outstanding.current === 0) setSaving(false);
    });
  }, [store, preferences]);

  /*
   * A place's id, generated once and never derived from anything.
   *
   * Governing: ADR-0010, SPEC-0011 REQ "A Place Is Authored, and a Plan
   * References It" — "The application MUST NOT mint a second identifier for
   * a place, and MUST NOT derive a place's identity from a plan's
   * assignments."
   *
   * `crypto.randomUUID` rather than a counter or a slug of the name,
   * because both of those are derivations: a counter collides across
   * devices the moment sync lands, and a name-derived id changes when the
   * player renames a place, which would silently reassign every leaf that
   * pointed at it.
   */
  const createPlace = useCallback(
    async (name: string): Promise<void> => {
      const trimmed = name.trim();
      if (trimmed === "") return;

      const written = await store.putPlace({
        id: crypto.randomUUID(),
        kind: "base",
        name: trimmed,
      });
      if (written.kind !== "ok") {
        setData((previous) => ({ ...previous, status: "unavailable" }));
        return;
      }

      setData((previous) => ({
        ...previous,
        status: "ready",
        places: [...previous.places, written.value],
        empty: false,
      }));
    },
    [store],
  );

  const removePlace = useCallback(
    async (id: string): Promise<void> => {
      const removed = await store.deletePlace(id);
      if (removed.kind !== "ok") {
        setData((previous) => ({ ...previous, status: "unavailable" }));
        return;
      }

      setData((previous) => {
        const places = previous.places.filter((place) => place.id !== id);
        return { ...previous, places, empty: places.length === 0 };
      });
    },
    [store],
  );

  const deleteEverything = useCallback(async (): Promise<void> => {
    const removed = await store.deleteAll();
    if (removed.kind !== "ok") {
      setData((previous) => ({ ...previous, status: "unavailable" }));
      return;
    }

    /*
     * Preferences live on the workspace record, so deletion took them too.
     * The view is reset to match rather than left showing settings whose
     * stored copy no longer exists — a screen that disagrees with the store
     * is how "I deleted my data" becomes "did I?".
     *
     * `written.current` is set *before* dispatching, so the write effect
     * sees no difference and does not immediately recreate the workspace
     * record that was just removed. Deletion that undoes itself one tick
     * later is the obvious failure here and it is silent.
     */
    written.current = INITIAL_VIEW_STATE.preferences;
    dispatch({
      type: "setPreference",
      field: "groupSeparator",
      value: INITIAL_VIEW_STATE.preferences.groupSeparator,
    });
    dispatch({
      type: "setPreference",
      field: "showUnverified",
      value: INITIAL_VIEW_STATE.preferences.showUnverified,
    });

    /*
     * Ready and empty, not a failure. SPEC-0009: deletion "MUST leave the
     * application in the designed empty state rather than in an error
     * state" — deleting your data is a thing you chose.
     */
    setData((previous) => ({
      ...previous,
      status: "ready",
      places: [],
      empty: true,
    }));
  }, [store, dispatch]);

  return { ...data, saving, deleteEverything, createPlace, removePlace };
}
