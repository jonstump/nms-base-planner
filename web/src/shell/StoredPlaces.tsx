import type { ReactNode } from "react";

import { StatusBadge } from "./StatusBadge";
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
 */
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
      <p className="label">
        Nothing saved on this device yet. Places you save will be listed here.
      </p>
    );
  }

  return (
    <ul className="figure-list">
      {data.places.map((place) => {
        const stocked = target === "" ? null : storedQuantity(place, target);
        return (
          <li key={place.id}>
            <span>{place.name ?? "Unnamed place"}</span>{" "}
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
              ))}
          </li>
        );
      })}
    </ul>
  );
}
