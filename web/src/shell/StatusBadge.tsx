import type { ReactNode } from "react";

/*
 * Governing: ADR-0004 (React view layer), SPEC-0005 Accessibility
 * Requirements
 *
 * "Colour MUST NOT be the sole carrier of any distinction."
 *
 * The rule is kept by making it impossible to express the violation. There
 * is no prop for "just the colour": a status is a member of the table below,
 * and every member has a glyph and a word alongside its token. A new status
 * added without them does not render differently — it does not compile.
 *
 * docs/design/theme/handoff.md carries the same rule at the token level, and
 * the reason it needs restating in a component is that a token is only a
 * colour. Nothing about `--warn` obliges the thing using it to say what it
 * means.
 */

export type Status = "ok" | "warning" | "danger" | "unverified" | "pending";

interface Presentation {
  /** Never the only difference. */
  readonly tokenClass: string;
  /** Redundant with the colour, on purpose. */
  readonly glyph: string;
  readonly label: string;
}

const PRESENTATION: Record<Status, Presentation> = {
  ok: { tokenClass: "status-ok", glyph: "✓", label: "OK" },
  warning: { tokenClass: "status-warning", glyph: "⚠", label: "Unassigned" },
  danger: { tokenClass: "status-danger", glyph: "✕", label: "Deficit" },
  unverified: { tokenClass: "status-unverified", glyph: "?", label: "Unverified" },
  pending: { tokenClass: "status-pending", glyph: "…", label: "Pending" },
};

export function StatusBadge({
  status,
  detail,
}: {
  status: Status;
  detail?: string;
}): ReactNode {
  const { tokenClass, glyph, label } = PRESENTATION[status];
  return (
    <span className={`status-badge label ${tokenClass}`}>
      {/*
        aria-hidden on the glyph and not on the word: a screen reader reading
        "✓ OK" says the check mark's name, which is noise. The word is the
        accessible carrier and the glyph is the visual one.
      */}
      <span aria-hidden="true" className="status-glyph">
        {glyph}
      </span>
      <span>{detail ? `${label} — ${detail}` : label}</span>
    </span>
  );
}

/** Exported so a test can enumerate every status rather than a chosen few. */
export const STATUSES = Object.keys(PRESENTATION) as readonly Status[];
