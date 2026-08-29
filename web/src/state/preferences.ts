/*
 * Moving preferences between view state and the store, without coercing.
 *
 * Governing: SPEC-0005 REQ "View State Boundaries", SPEC-0009 REQ "View
 * Preferences Survive a Reload"
 *
 * `ViewState.preferences` is a typed pair; the store holds
 * `Record<string, string | boolean>`, because the workspace record has to
 * outlive whatever the view's preference set happens to be this month.
 * Something has to cross between them, and the crossing is where a stored
 * value gets to be the wrong type.
 *
 * So the decode is strict and never coerces. A stored `"false"` — the
 * string, which is what a JSON round-trip through the wrong writer
 * produces — is not a boolean, and turning it into `true` by truthiness
 * would silently flip a preference the player had set. It falls back to the
 * initial value instead, which is the one outcome that is never a surprise.
 */

import { INITIAL_VIEW_STATE, type ViewState } from "./view-state";

export type Preferences = ViewState["preferences"];

/** The shape the store holds. Deliberately wider than `Preferences`. */
export type StoredPreferences = Readonly<Record<string, string | boolean>>;

export function toStored(preferences: Preferences): StoredPreferences {
  return {
    groupSeparator: preferences.groupSeparator,
    showUnverified: preferences.showUnverified,
  };
}

/**
 * Read preferences out of a workspace record.
 *
 * Every field is checked by `typeof` and falls back independently: one
 * unreadable preference does not discard the other. That is the opposite of
 * the store's all-or-nothing rule for places, and the difference is
 * deliberate — a half-loaded workspace hides places the player has, where a
 * preference falling back to its default is visible on screen immediately
 * and costs one click to correct.
 */
export function fromStored(stored: StoredPreferences | undefined): Preferences {
  const fallback = INITIAL_VIEW_STATE.preferences;
  if (!stored) return fallback;

  const groupSeparator = stored["groupSeparator"];
  const showUnverified = stored["showUnverified"];

  return {
    groupSeparator:
      typeof groupSeparator === "string" ? groupSeparator : fallback.groupSeparator,
    showUnverified:
      typeof showUnverified === "boolean" ? showUnverified : fallback.showUnverified,
  };
}

/** Whether two preference sets differ, so a no-op change writes nothing. */
export function differ(a: Preferences, b: Preferences): boolean {
  return a.groupSeparator !== b.groupSeparator || a.showUnverified !== b.showUnverified;
}
