import type { ReactNode } from "react";

import { StatusBadge } from "../shell/StatusBadge";

/*
 * Provenance markers, at two scales.
 *
 * Governing: ADR-0004 (React view layer), SPEC-0007 REQ "Provenance on
 * Displayed Figures", SPEC-0005 Accessibility Requirements
 *
 * Two components because the requirement names two facts and forbids
 * substituting one for the other: "a base marked verified says nothing about
 * a row, and a single marked row does not make the base's own figures
 * suspect." One shared component taking a scale prop would make the
 * substitution a one-character edit.
 *
 * The row marker is deliberately smaller than the base's, and the reason is
 * the requirement's own warning rather than taste. Every producer row is
 * unverified today — no curated constant carries a verified date — so this
 * marker is on everything, not on the occasional row. A treatment tuned
 * against two chips in a prototype becomes thirty badges here, and a card
 * that is legible with two and unreadable with thirty has not met the
 * requirement. So the row carries a glyph with an accessible name and the
 * base carries the full badge, once.
 *
 * Neither is styled as an error. `status-unverified` is its own token, and
 * `?` is its own glyph — distinct from `⚠` for a warning and `✕` for a
 * deficit, which is what "without styling it as an error" asks for and what
 * a test asserts against both.
 *
 * Nothing here computes a flag. The boolean is the domain's answer about
 * that row's own arithmetic, and re-deriving it would be SPEC-0005's
 * forbidden arithmetic applied to a boolean.
 */

/** One row's provenance. Compact, because it will be on every row. */
export function RowProvenance({ verified }: { verified: boolean }): ReactNode {
  if (verified) return null;
  return (
    <span
      className="card-unverified status-unverified"
      data-provenance="row"
      /*
       * The glyph is decorative and the name is the carrier: a screen reader
       * reading "question mark" is noise, and the word is what makes the
       * distinction survive not seeing the colour.
       */
      role="img"
      aria-label="Unverified"
      title="Unverified — rests on a constant with no confirmed date"
    >
      <span aria-hidden="true">?</span>
    </span>
  );
}

/**
 * The base's own provenance.
 *
 * Reports whether everything contributing to this base's instructions was
 * confirmed. It is not a summary of the row markers and must not be read as
 * one — the payload carries it separately for that reason.
 */
export function BaseProvenance({ verified }: { verified: boolean }): ReactNode {
  if (verified) return null;
  return (
    <span data-provenance="base">
      <StatusBadge status="unverified" detail="base figures" />
    </span>
  );
}
