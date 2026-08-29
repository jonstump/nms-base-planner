import { useCallback, useId, useState, type ReactNode } from "react";

import {
  formatQuantity,
  isQuantity,
  type BoundaryClient,
  type Failure,
} from "../boundary";
import { LiveRegionProvider } from "../a11y/LiveRegion";
import { useAnnounceOnChange } from "../a11y/useLiveRegion";
import { Popover } from "../a11y/Popover";
import { ViewStateProvider } from "../state/ViewStateProvider";
import { useViewDispatch, useViewState } from "../state/useViewState";
import { usePlanResolution, type Resolution } from "../state/usePlanResolution";
import { useStoredData } from "../state/useStoredData";
import { DurableStore } from "../store";
import { StatusBadge } from "./StatusBadge";
import { StoredPlaces } from "./StoredPlaces";
import { ViewPreferences } from "./ViewPreferences";

/*
 * The shell every surface mounts into.
 *
 * Governing: ADR-0004 (React view layer), SPEC-0005 REQ "View State
 * Boundaries", Accessibility Requirements
 *
 * Four landmarks, once each. A second <main> or a second unlabelled <nav>
 * makes a landmark list ambiguous, which is worse than having none: a screen
 * reader user navigating by landmark lands somewhere and cannot tell which
 * one they are in.
 *
 * The tree canvas (SPEC-0006) and base planner card (SPEC-0007) mount into
 * the <main> below. They inherit the live region, the focus trap and the
 * status badge rather than reimplementing them, which is the point of
 * building them here.
 */

/*
 * A failure's short form, selected on the discriminant and the stable code —
 * never on the message.
 *
 * A contract mismatch is not one of the codes: it is its own outcome kind,
 * because SPEC-0005 requires it to be reported naming both versions rather
 * than folded into a generic failure the user cannot act on.
 */
function failureSummary(outcome: Failure): string {
  return outcome.kind === "version-mismatch"
    ? `contract ${outcome.received}, expected ${outcome.expected}`
    : outcome.code;
}

function describeResolution(resolution: Resolution, groupSeparator: string): string {
  switch (resolution.status) {
    case "resolved": {
      const target = resolution.graph.nodes.at(-1);
      const total = target ? formatQuantity(target.total, { groupSeparator }) : "";
      return `${resolution.graph.nodes.length} steps for ${total} ${target?.name ?? "items"}. Totals updated.`;
    }
    case "failed":
      return `The plan could not be resolved: ${failureSummary(resolution.outcome)}. Totals unchanged.`;
    case "unusable":
      return "The plan is incomplete. Totals unchanged.";
    default:
      return "Totals updated.";
  }
}

function PlanForm({ onRecompute }: { onRecompute: () => void }): ReactNode {
  const state = useViewState();
  const dispatch = useViewDispatch();
  const targetId = useId();
  const quantityId = useId();

  const quantityLooksUsable = isQuantity(state.inputs.quantity);

  return (
    <form
      className="plan-form"
      onSubmit={(event) => {
        event.preventDefault();
        onRecompute();
      }}
    >
      <div className="control-row">
        <label className="label" htmlFor={targetId}>
          Target
        </label>
        <input
          id={targetId}
          className="control"
          value={state.inputs.target}
          onChange={(event) => {
            dispatch({ type: "setInput", field: "target", value: event.target.value });
          }}
        />

        <label className="label" htmlFor={quantityId}>
          Quantity
        </label>
        <input
          id={quantityId}
          className="control"
          inputMode="numeric"
          value={state.inputs.quantity}
          /*
           * aria-invalid rather than a red border alone. The border is the
           * visual signal and this is the one a screen reader has.
           */
          aria-invalid={!quantityLooksUsable}
          aria-describedby={quantityLooksUsable ? undefined : `${quantityId}-hint`}
          onChange={(event) => {
            dispatch({ type: "setInput", field: "quantity", value: event.target.value });
          }}
        />

        <button type="submit" className="control control-primary interactive">
          Recompute
        </button>
      </div>

      {!quantityLooksUsable && (
        <p id={`${quantityId}-hint`} className="label">
          <StatusBadge
            status="warning"
            detail="a whole number or an exact fraction like 3/2"
          />
        </p>
      )}
    </form>
  );
}

function Figures({ resolution }: { resolution: Resolution }): ReactNode {
  const { preferences } = useViewState();
  const dispatch = useViewDispatch();
  const [detailOpen, setDetailOpen] = useState(false);
  const headingId = useId();

  if (resolution.status === "pending") {
    /*
     * SPEC-0005 REQ "Module Loading": pending, never zero. A zero here would
     * be a figure the domain never produced, presented as though it had.
     */
    return <StatusBadge status="pending" detail="waiting for the planner module" />;
  }

  if (resolution.status === "failed") {
    return <StatusBadge status="danger" detail={failureSummary(resolution.outcome)} />;
  }

  if (resolution.status !== "resolved") {
    return <p className="label">Enter a target and recompute.</p>;
  }

  const nodes = resolution.graph.nodes;

  return (
    <>
      <h3 id={headingId}>{nodes.at(-1)?.name ?? resolution.graph.target}</h3>
      <ul className="figure-list">
        {nodes.map((node) => (
          <li key={node.itemId}>
            <button
              type="button"
              className="control control-sm interactive selectable figure-row"
              onClick={() => {
                dispatch({ type: "select", nodeId: node.itemId });
                setDetailOpen(true);
              }}
            >
              <span>{node.name}</span>{" "}
              <span className="numeral">
                {formatQuantity(node.total, {
                  groupSeparator: preferences.groupSeparator,
                })}
              </span>
              {!node.verified && <StatusBadge status="unverified" />}
            </button>
          </li>
        ))}
      </ul>

      <Popover
        open={detailOpen}
        labelledBy={headingId}
        onClose={() => {
          setDetailOpen(false);
        }}
      >
        <h3>Node detail</h3>
        <p className="label">Selection is view state; the figures above are not.</p>
      </Popover>
    </>
  );
}

function Chrome({
  client,
  store,
}: {
  readonly client: BoundaryClient;
  readonly store: DurableStore;
}): ReactNode {
  const state = useViewState();
  const { resolution, resultToken, recompute } = usePlanResolution(client, state);
  const stored = useStoredData(store);

  /*
   * The announcement is keyed to the result token, which changes exactly when
   * a crossing produces a new answer — not on render, not on a preference
   * change, not on a re-render caused by a parent.
   */
  useAnnounceOnChange(resultToken, () =>
    describeResolution(resolution, state.preferences.groupSeparator),
  );

  const onRecompute = useCallback(() => {
    recompute();
  }, [recompute]);

  return (
    <div className="shell">
      <header className="shell-banner panel">
        <h2>NMS Base Planner</h2>
      </header>

      <nav className="shell-nav" aria-label="Surfaces">
        <ul className="control-row">
          <li>
            <button
              type="button"
              className="control control-sm interactive"
              aria-current="page"
            >
              Plan
            </button>
          </li>
        </ul>
      </nav>

      <main className="shell-main">
        <PlanForm onRecompute={onRecompute} />
        <section className="panel" aria-label="Figures">
          <Figures resolution={resolution} />
        </section>

        <section className="panel" aria-label="Saved places">
          <StoredPlaces data={stored} target={state.inputs.target} />
        </section>

        {/*
          `data-saving` reports whether a preference write is still in
          flight. It carries no user-facing claim — SPEC-0009 REQ "Storage
          Is Evictable" governs what may be *said* about stored data, and
          that indication belongs to the data-custody story rather than
          here.

          Issue numbers are spelled without the leading hash in this file.
          check-tokens.sh matches a hash followed by three to eight hex
          digits, and plenty of issue numbers are exactly that — so the
          reference reads as a colour literal and fails the gate. Caught in
          CI after passing locally, and then again by the comment written to
          explain it, which had quoted the offending form.
        */}
        <section
          className="panel"
          aria-label="Preferences"
          data-saving={String(stored.saving)}
        >
          <ViewPreferences />
        </section>
      </main>

      <footer className="shell-footer">
        <p className="label">
          Figures come from the planner module. Nothing on this page is computed here.
        </p>
      </footer>
    </div>
  );
}

/**
 * `store` is injectable so a test can use its own database.
 *
 * Constructed at module scope rather than defaulted in the parameter list,
 * which would build a new store on every render and reopen the connection
 * each time.
 */
const APP_STORE = new DurableStore();

export function AppShell({
  client,
  store = APP_STORE,
}: {
  readonly client: BoundaryClient;
  readonly store?: DurableStore;
}): ReactNode {
  return (
    <ViewStateProvider>
      <LiveRegionProvider>
        <Chrome client={client} store={store} />
      </LiveRegionProvider>
    </ViewStateProvider>
  );
}
