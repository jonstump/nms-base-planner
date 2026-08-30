import {
  lazy,
  Suspense,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  EMPTY_PLAN,
  formatQuantity,
  isQuantity,
  validatePlan,
  type BoundaryClient,
  type Failure,
} from "../boundary";
import { LiveRegionProvider } from "../a11y/LiveRegion";
import { useAnnounceOnChange, useLiveRegion } from "../a11y/useLiveRegion";
import { Popover } from "../a11y/Popover";
import { ViewStateProvider } from "../state/ViewStateProvider";
import { useViewDispatch, useViewState } from "../state/useViewState";
import { usePlanResolution, type Resolution } from "../state/usePlanResolution";
import { useStoredData } from "../state/useStoredData";
import { basesFrom } from "../canvas/bases";
import { useLeafAssignment } from "../canvas/useLeafAssignment";
import { DurableStore } from "../store";
import { StatusBadge } from "./StatusBadge";

/*
 * The canvas arrives when there is a graph to draw.
 *
 * Governing: SPEC-0005 REQ "Module Loading"
 *
 * The same argument the WASM binary gets, applied to the two dependencies
 * SPEC-0006 brings. Statically imported, React Flow and elkjs take the
 * initial bundle from 222 kB to 1,864 kB raw (69 kB to 575 kB gzipped) —
 * paid on first paint by every player, including one who has not resolved
 * anything. Split out, first paint is back to 232 kB raw / 71 kB gzipped
 * and the canvas is fetched when a plan first resolves.
 *
 * elkjs splits again inside layout.ts: it is 1.6 MB on its own and is not
 * needed until something is actually laid out.
 */
const TreeCanvas = lazy(async () => ({
  default: (await import("../canvas/TreeCanvas")).TreeCanvas,
}));
import { DataCustody } from "./DataCustody";
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

/**
 * Method overrides, carried with the target they were chosen against.
 *
 * Plan state, not view state — SPEC-0005 keeps the plan out of `ViewState`
 * and ADR-0002 puts its permanent home in the URL hash, which is not wired
 * yet (SPEC-0005 records the decode-on-load path as an open question). Held
 * here beside the crossing that consumes them, the way the result cache is.
 */
interface MethodOverrides {
  readonly target: string;
  readonly methods: Readonly<Record<string, string>>;
}

const NO_OVERRIDES: MethodOverrides = Object.freeze({
  target: "",
  methods: Object.freeze({}),
});

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

  /*
   * Per-node method overrides: plan state, held here rather than in
   * `ViewState`.
   *
   * SPEC-0005 REQ "View State Boundaries" keeps the plan out of view state,
   * and ADR-0002 puts its permanent home in the URL hash. `encodePlanToHash`
   * exists and nothing calls it — SPEC-0005 records the decode-on-load path
   * as an open question — so until that lands these live beside the
   * crossing that consumes them, the way the result cache does.
   */
  const [override, setOverride] = useState<MethodOverrides>(NO_OVERRIDES);

  /*
   * Overrides belong to the target they were chosen against, so they are
   * stored with it and *derived* away when it changes rather than cleared
   * by an effect. An effect calling setState here would be a cascading
   * render, and the derivation says the same thing more directly: an
   * override keyed by an item id from the previous tree is not an override
   * for this one.
   */
  const methods =
    override.target === state.inputs.target ? override.methods : NO_OVERRIDES.methods;
  const { resolution, resultToken, recompute, recomputeWith } = usePlanResolution(
    client,
    state,
    methods,
  );
  const stored = useStoredData(store);

  /*
   * The announcement is keyed to the result token, which changes exactly when
   * a crossing produces a new answer — not on render, not on a preference
   * change, not on a re-render caused by a parent.
   */
  /*
   * What changed, for the announcement.
   *
   * SPEC-0006 Accessibility Requirements: a method change "MUST be
   * announced through an aria-live='polite' region naming what changed and
   * that totals updated". The existing description says totals updated; it
   * cannot say what caused it, so the cause is recorded here and consumed
   * by the next announcement.
   *
   * Held in a ref and read at announce time rather than announced on the
   * click: "totals updated" said before the crossing returns is a claim
   * about a recompute that has not happened.
   */
  const pendingChange = useRef<string | null>(null);
  const { announce } = useLiveRegion();

  /*
   * The plan the assignment hook sends with its rollup. Built through
   * `validatePlan` rather than assembled by hand — SPEC-0005 makes it the
   * single gate, and a second construction path is a second thing to drift.
   */
  const plan = useMemo(() => {
    const validated = validatePlan({
      target: state.inputs.target,
      quantity: state.inputs.quantity,
      methods,
    });
    return validated.ok ? validated.plan : EMPTY_PLAN;
  }, [state.inputs.target, state.inputs.quantity, methods]);

  /*
   * The assignable places, and the ids the assignment rule is resolved
   * against. Both derived from the store rather than from a list this file
   * holds: SPEC-0011 REQ "A Place Is Authored, and a Plan References It"
   * makes a place something the player authored, so there is no set of
   * bases until there are records.
   */
  const bases = useMemo(() => basesFrom(stored.places), [stored.places]);
  const placeIds = useMemo(() => bases.map((base) => base.id), [bases]);

  /*
   * `constants: null` is not a stub. `RollupRequest` requires curated
   * constants and the application has no source for them — they exist only
   * in test fixtures, and the base planner card that would own them is not
   * mounted either. So assignments are held and rendered here, and the
   * stage-2 dispatch this hook performs is exercised where constants exist.
   */
  const { assignments, assign } = useLeafAssignment({
    client,
    plan,
    constants: null,
    placeIds,
  });

  useAnnounceOnChange(resultToken, () => {
    const change = pendingChange.current;
    pendingChange.current = null;
    const described = describeResolution(resolution, state.preferences.groupSeparator);
    return change === null ? described : `${change} ${described}`;
  });

  const onAssign = useCallback(
    (nodeId: string, name: string, baseId: string | null) => {
      assign(nodeId, baseId);

      /*
       * Announced directly rather than through the recompute's description.
       * SPEC-0006 requires an assignment change be announced naming what
       * changed; it also expects "totals updated", and saying so here would
       * be false while no recompute is dispatched. What is true is the
       * assignment, so that is what is said.
       */
      const label = bases.find((base) => base.id === baseId)?.label;
      announce(
        label === undefined
          ? `${name} is no longer assigned to a base.`
          : `${name} assigned to ${label}.`,
      );
    },
    [assign, announce, bases],
  );

  const onSelectMethod = useCallback(
    (nodeId: string, name: string, method: string) => {
      pendingChange.current = `${name} set to ${method}.`;
      const next = { ...methods, [nodeId]: method };
      setOverride({ target: state.inputs.target, methods: next });
      /*
       * `recomputeWith`, not `recompute`: `setMethods` has not re-rendered
       * yet, so `recompute` would cross with the previous overrides and
       * resolve the plan the player just changed away from.
       */
      recomputeWith(next);
    },
    [methods, recomputeWith, state.inputs.target],
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

        {/*
          The canvas sits beside the figure list rather than replacing it,
          for one story.

          SPEC-0006 puts the canvas where the flat list is, and that is
          where it will end up. But the list's rows are currently what the
          SPEC-0005 accessibility suite drives — the focus trap, the
          selection ring and the live region's invoker are all tested
          through `.figure-row` — and the canvas card has no control to open
          until the method-selection story lands. Removing the list now
          would leave those requirements untested in between, which is a
          worse trade than a surface that shows its figures twice for a
          release or two.
        */}
        {resolution.status === "resolved" && (
          <section className="panel" aria-label="Tree">
            <Suspense
              fallback={<StatusBadge status="pending" detail="loading the canvas" />}
            >
              <TreeCanvas
                graph={resolution.graph}
                onSelectMethod={onSelectMethod}
                assignments={assignments}
                onAssign={onAssign}
                bases={bases}
              />
            </Suspense>
          </section>
        )}

        <section className="panel" aria-label="Saved places">
          <StoredPlaces data={stored} target={state.inputs.target} />
        </section>

        <section className="panel" aria-label="Your data">
          <DataCustody data={stored} />
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
