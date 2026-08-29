import type { ReactNode } from "react";

import { formatQuantity, type PowerBudget } from "../boundary";
import { StatusBadge } from "../shell/StatusBadge";

/*
 * The base's power position, and what to do about a deficit.
 *
 * Governing: ADR-0004 (React view layer), SPEC-0007 REQ "Power Position",
 * REQ "Deficit Is an Action, Including When It Cannot Be Sized",
 * SPEC-0005 REQ "The View Computes No Domain Values"
 *
 * Generation, draw and balance are all the domain's. `balance` is a payload
 * field, not `generation - draw` computed here — the subtraction is exactly
 * what REQ "Power Position" forbids, and it is forbidden because the domain
 * computes in exact rationals and the view would be doing it in floats.
 *
 * No meter is drawn. The requirement permits a proportional indicator and
 * forbids computing its proportion from the two figures, and the payload
 * reports no proportion — so a bar here would have to be arithmetic the card
 * is not allowed to do. Three exact figures and a stated position carry the
 * relationship without inventing one.
 *
 * The deficit badge is StatusBadge rather than a local treatment: it already
 * pairs a glyph and a word with every colour, which is the whole of "a
 * deficit MUST be conveyed by more than colour", and a second implementation
 * would be a second place for that rule to lapse.
 */

export interface PowerBlockProps {
  readonly budget: PowerBudget;
  /** The configured generator class, where one is set. */
  readonly emClass?: string | undefined;
}

function Figure({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <span className="card-figure">
      <span className="card-figure-label">{label}</span>
      <span className="card-figure-value mono">{value}</span>
    </span>
  );
}

export function PowerBlock({ budget, emClass }: PowerBlockProps): ReactNode {
  const sized = budget.inDeficit && !budget.fixUnsized;

  return (
    <section className="card-section card-power" data-section="power">
      <h4 className="card-section-head">Power</h4>

      <div className="card-row-figures" data-power="position">
        <Figure label="Generation" value={formatQuantity(budget.generation)} />
        <Figure label="Draw" value={formatQuantity(budget.draw)} />
        {/* The domain's own value, negative in deficit. Not a subtraction. */}
        <Figure label="Balance" value={formatQuantity(budget.balance)} />
      </div>

      {budget.inDeficit ? (
        <div className="card-deficit" data-power="deficit">
          {/*
            Symbol, word and the shortfall as a stated quantity — the state
            survives colour being removed entirely, which is the point of
            the requirement rather than a nicety.
          */}
          <StatusBadge status="danger" detail={formatQuantity(budget.deficit)} />

          {sized ? (
            /*
              An action, not a warning to interpret: the count, what to build,
              and the position it produces.
            */
            <p className="card-fix" data-fix="sized">
              Build{" "}
              <span className="card-figure-value mono" data-testid="fix-count">
                {formatQuantity(budget.additionalGenerators)}
              </span>{" "}
              more {emClass === undefined ? "" : `class ${emClass} `}
              electromagnetic generators to clear the shortfall.{" "}
              <span className="card-fix-position">
                That takes this base out of deficit.
              </span>
            </p>
          ) : (
            /*
              `fixUnsized` is the state design.md warns reads as "nothing to
              show": a budget in deficit with additionalGenerators of zero.
              The deficit stays visible and the fix is stated as needing a
              class — never offered as a count, because the domain did not
              report one and the card must not size a fix it was not given.
            */
            <p className="card-fix" data-fix="unsized">
              This fix needs a generator class before it can be costed. No generator count
              is offered, because the domain reported none.
            </p>
          )}
        </div>
      ) : (
        <p className="card-surplus" data-power="surplus">
          <StatusBadge status="ok" detail={`surplus ${formatQuantity(budget.balance)}`} />
        </p>
      )}
    </section>
  );
}
