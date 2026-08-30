import { useId, useState, type ReactNode } from "react";

import { StatusBadge } from "./StatusBadge";
import { UNNAMED_PLACE } from "../canvas/bases";
import { useLiveRegion } from "../a11y/useLiveRegion";
import { ABSENT_DISPLAY, ABSENT_LABEL, storedQuantity } from "../store/absence";
import type { StoredData } from "../state/useStoredData";

/*
 * Governing: ADR-0008 (durable user data), SPEC-0009 REQ "An Empty Store Is
 * a Designed State"
 *
 * The first surface to read the store, and the one that establishes what
 * later ones inherit. Three states that are genuinely different and are not
 * collapsed into two:
 *
 *   loading      — the read has not finished. Not empty.
 *   ready+empty  — the read finished and there was nothing. Not a failure.
 *   unavailable  — IndexedDB is blocked. A failure, and said so.
 *
 * Collapsing loading into empty is the flash of "nothing saved" at a player
 * who has data, which reads as loss rather than latency. Collapsing empty
 * into unavailable is the one SPEC-0009 names directly: a fresh device, a
 * private window and cleared storage all produce empty, and all of them are
 * ordinary.
 *
 * The quantity column is the other half. A place with nothing stocked for
 * the target shows an em dash, never `0` — see src/store/absence.ts for why
 * `?? 0` is the defect this contract exists to prevent.
 *
 * It is also the route by which a place comes to exist.
 *
 * Governing: ADR-0010 (places are authored first), SPEC-0011 REQ "A Place Is
 * Creatable by Hand" — "The bases surface MUST provide a route to create a
 * place without a save file, independent of SPEC-0008."
 *
 * A name and nothing else, because the requirement makes that the whole
 * minimum: "Every other field ... MUST be optional at creation." Asking for
 * a kind or a site configuration first would make the first-run path longer
 * than the thing it unblocks, and a place with no site configuration is
 * assignable by rule — the card renders that gap as a gap.
 */
/**
 * The create-a-place form.
 *
 * Governing: SPEC-0011 REQ "A Place Is Creatable by Hand"
 *
 * A real `<form>` so Enter submits: the requirement is that a place be
 * creatable, and a control that needs a mouse to reach its button would put
 * the route behind a pointing device.
 */
function CreatePlace({ create }: { readonly create: (name: string) => Promise<void> }) {
  const fieldId = useId();
  const [name, setName] = useState("");
  const { announce } = useLiveRegion();

  return (
    <form
      className="place-create"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = name.trim();
        if (trimmed === "") return;
        /*
         * Cleared before the write settles. The player has moved on to
         * typing the next one, and a field that empties late eats the first
         * characters of it.
         */
        setName("");
        void create(trimmed).then(() => {
          announce(`${trimmed} created.`);
        });
      }}
    >
      <label className="label" htmlFor={fieldId}>
        New place
      </label>{" "}
      <input
        id={fieldId}
        className="control control-sm interactive"
        value={name}
        onChange={(event) => {
          setName(event.target.value);
        }}
        placeholder="Name"
      />{" "}
      <button
        type="submit"
        className="control control-sm interactive"
        /*
         * Disabled on an empty name rather than accepting one and
         * generating a placeholder. The name is the minimum the requirement
         * sets, and a place called "Unnamed place" is not a place the player
         * can pick out of a list.
         */
        disabled={name.trim() === ""}
      >
        Create place
      </button>
    </form>
  );
}

export function StoredPlaces({
  data,
  target,
}: {
  readonly data: StoredData;
  readonly target: string;
}): ReactNode {
  if (data.status === "loading") {
    return <StatusBadge status="pending" detail="reading saved places" />;
  }

  if (data.status === "unavailable") {
    return (
      <StatusBadge
        status="warning"
        detail="this browser is not storing data for this site"
      />
    );
  }

  if (data.empty) {
    return (
      <>
        <p className="label">
          Nothing saved on this device yet. Places you create will be listed here.
        </p>
        <CreatePlace create={data.createPlace} />
      </>
    );
  }

  return (
    <>
      <CreatePlace create={data.createPlace} />
      <ul className="figure-list">
        {data.places.map((place) => {
          const stocked = target === "" ? null : storedQuantity(place, target);
          return (
            <li key={place.id} data-place={place.id}>
              <span>{place.name ?? UNNAMED_PLACE}</span>{" "}
              {stocked !== null &&
                (stocked.present ? (
                  <span className="numeral">{stocked.value}</span>
                ) : (
                  /*
                   * The dash is for sighted readers; the label is what a
                   * screen reader says. "—" announces as nothing in most of
                   * them, and a row that reads as a name followed by silence
                   * is indistinguishable from a broken one.
                   */
                  <span className="numeral" aria-label={ABSENT_LABEL}>
                    {ABSENT_DISPLAY}
                  </span>
                ))}{" "}
              {/*
              Deleting a place does not touch any plan.

              Governing: ADR-0010 (a deleted place unassigns; it does not
              cascade and does not dangle), SPEC-0011 REQ "An Assignment
              Naming an Absent Place Is Unassigned"

              Leaves assigned here return to the unassigned group rather
              than being removed with the place — the plan is the expensive
              artifact, not the record. The label names the place because a
              row of identical "Delete" buttons is unusable by anyone
              navigating by control rather than by row.
            */}
              <button
                type="button"
                className="control control-sm interactive"
                aria-label={`Delete ${place.name ?? UNNAMED_PLACE}`}
                onClick={() => {
                  void data.removePlace(place.id);
                }}
              >
                Delete
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
