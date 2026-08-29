import type { ReactNode } from "react";

import { formatQuantity, type Quantity } from "../boundary";

/*
 * A duration, presented as the estimate it is.
 *
 * Governing: ADR-0004 (React view layer), SPEC-0007 REQ "Duration Display",
 * SPEC-0005 REQ "The View Computes No Domain Values"
 *
 * The domain's rate constants do not state their time unit. The artifact
 * does not record it, and the engine's arithmetic is consistent under either
 * reading while its absolute durations are not — so a figure rendered here
 * as "1800 s" would be a precision claim the underlying data cannot support.
 * `≈` and the word "est." are the whole of the fix, and they are on every
 * duration rather than on the ones that felt uncertain.
 *
 * No conversion happens here. Turning 1800 into "30 min" is arithmetic the
 * card is not allowed to do, and where a duration is displayed in a unit
 * other than the payload's, that conversion is the domain's to make. The
 * card's discipline scan is what enforces the absence.
 */
export function Duration({
  label,
  seconds,
}: {
  label: string;
  seconds: Quantity;
}): ReactNode {
  return (
    <span className="card-figure" data-duration={label}>
      <span className="card-figure-label">{label}</span>
      <span className="card-figure-value mono">
        {/*
          The sign is decorative and "est." is the carrier. Screen readers
          disagree about how to announce ≈ — some say "almost equal to", some
          skip it — so the claim is carried by a word that reads the same
          everywhere, and the symbol only reinforces it visually.
        */}
        <span aria-hidden="true">≈</span>
        {formatQuantity(seconds)}
      </span>
      <span className="card-estimate">est.</span>
    </span>
  );
}
