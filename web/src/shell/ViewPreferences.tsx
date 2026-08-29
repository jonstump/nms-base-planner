import { useId, type ReactNode } from "react";

import { useViewDispatch, useViewState } from "../state/useViewState";

/*
 * Governing: SPEC-0005 REQ "View State Boundaries", SPEC-0009 REQ "View
 * Preferences Survive a Reload"
 *
 * The controls existed nowhere before this. `ViewState.preferences` held two
 * values that only the initial state ever set, which made "a preference that
 * forgets itself" academic — nothing could change one in the first place.
 *
 * "Show unverified" rather than "Show unverified figures", which is what it
 * first said: the shell's figures region is named "Figures", and Playwright's
 * getByLabel matches on substring, so the longer label made an existing
 * locator ambiguous. Two controls whose accessible names contain the same
 * word is a real ambiguity for anyone navigating by label, not only for the
 * test that caught it.
 *
 * These dispatch into view state and nothing else. Persisting them is
 * `useStoredData`'s job, one layer out, and deliberately not wired through
 * here: a control that wrote to the store directly would be a second source
 * of truth for a value the view already owns.
 */
export function ViewPreferences(): ReactNode {
  const { preferences } = useViewState();
  const dispatch = useViewDispatch();
  const groupId = useId();
  const unverifiedId = useId();

  return (
    <fieldset className="preferences">
      <legend className="label">Display</legend>

      <div className="control-row-sm">
        <input
          id={groupId}
          type="checkbox"
          className="control control-sm interactive"
          checked={preferences.groupSeparator !== ""}
          onChange={(event) => {
            dispatch({
              type: "setPreference",
              field: "groupSeparator",
              /*
               * The separator is the stored value, not a boolean. "" is a
               * real setting — digits ungrouped — and is why the preference
               * is a string rather than a flag.
               */
              value: event.target.checked ? "," : "",
            });
          }}
        />
        <label htmlFor={groupId}>Group digits</label>
      </div>

      <div className="control-row-sm">
        <input
          id={unverifiedId}
          type="checkbox"
          className="control control-sm interactive"
          checked={preferences.showUnverified}
          onChange={(event) => {
            dispatch({
              type: "setPreference",
              field: "showUnverified",
              value: event.target.checked,
            });
          }}
        />
        <label htmlFor={unverifiedId}>Show unverified</label>
      </div>
    </fieldset>
  );
}
