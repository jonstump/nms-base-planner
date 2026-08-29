import type { ReactNode } from "react";

import {
  formatQuantity,
  type BaseBuild,
  type ExtractorRow,
  type FarmRow,
  type KitchenStep,
  type NoBuildRow,
  type PowerBudget,
  type Quantity,
  type RanchRow,
} from "../boundary";
import { StatusBadge } from "../shell/StatusBadge";

import { BuildFooter } from "./BuildFooter";
import { buildItems } from "./build-items";
import { CardControls } from "./CardControls";
import { Duration } from "./Duration";
import type { CardConfiguration } from "./configuration";
import { PowerBlock } from "./PowerBlock";
import { BaseProvenance, RowProvenance } from "./Provenance";
import { PRODUCER_HEADING, presentKinds, type ProducerKind } from "./sections";

/*
 * One base's construction instructions.
 *
 * Governing: ADR-0004 (React view layer), SPEC-0007 REQ "Card Composition
 * From the Build Payload", REQ "Base Identity and Selection", REQ "Producer
 * Sections", REQ "Byproducts Are Shown, Not Omitted", SPEC-0005 REQ "The
 * View Computes No Domain Values", REQ "Component Styling Discipline"
 *
 * Every number rendered here arrives as a Quantity and leaves through
 * formatQuantity, which only groups digits. There is no division, no
 * rounding and no Number() in this file, and tests/card/discipline.spec.ts
 * asserts that mechanically rather than trusting this comment — SPEC-0007
 * forbids computing a count from a quantity and a rate *even where both are
 * in the payload*, which is precisely the tempting case: a farm row carries
 * both `required` and `yieldPerPlant`, and `plants` is already the answer.
 *
 * `nutrientProcessors` and `pelletFeeders` are rendered once, on the section
 * that owns them, and never inside a row. They are base-level figures: a
 * base with three kitchen steps has one processor count, and summing a
 * per-row value would report three times the build.
 *
 * The card takes its identity slot as a prop because base identity metadata
 * has no source yet — SPEC-0007's overview names it as one of three things
 * this card displays that nothing built or specified provides. Absent a
 * slot the card says so, with the dashed frame *and* a badge, because
 * SPEC-0005 forbids colour carrying a distinction alone.
 */

/** 1-6 map to the categorical base palette; absent means no identity assigned. */
export type IdentitySlot = 1 | 2 | 3 | 4 | 5 | 6;

export interface BasePlannerCardProps {
  readonly base: BaseBuild;
  readonly identity?: IdentitySlot;
  readonly selected?: boolean;
  readonly onSelect?: (base: string) => void;
  /*
   * Configuration is optional so the card still renders against a payload
   * alone. SPEC-0007 REQ "Absent Data Is Absent" requires the card render
   * "using only the plan payloads and the base identifier", and a card that
   * needed a configuration to draw would make that false.
   */
  readonly configuration?: CardConfiguration;
  readonly onConfigure?: (next: CardConfiguration) => void;
  readonly budget?: PowerBudget | undefined;
}

/** Digits grouped, magnitude untouched. The only formatting SPEC-0005 permits. */
function q(value: Quantity): string {
  return formatQuantity(value);
}

function Figure({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <span className="card-figure">
      <span className="card-figure-label">{label}</span>
      <span className="card-figure-value mono">{value}</span>
    </span>
  );
}

function FarmRowView({ row }: { row: FarmRow }): ReactNode {
  return (
    <li className="card-row" data-row="farm" data-item={row.itemId}>
      <span className="card-row-name">{row.name}</span>
      <span className="card-row-figures">
        <Figure label="Required" value={q(row.required)} />
        {/* What to build. SPEC-0007: never the required quantity alone. */}
        <Figure label="Plants" value={q(row.plants)} />
        <Figure label="Biodomes" value={q(row.biodomes)} />
        {/*
          Both bounds, always together. The domain sized `plants` on the
          pessimistic one; showing the optimistic bound by itself would
          present a planning figure that produces a build that does not work.
        */}
        <Figure
          label="Yield/plant"
          value={`${q(row.yieldPerPlant.min)}–${q(row.yieldPerPlant.max)}`}
        />
        <Duration label="Growth (s)" seconds={row.growthSeconds} />
        <RowProvenance verified={row.verified} />
      </span>
    </li>
  );
}

function ExtractorRowView({ row }: { row: ExtractorRow }): ReactNode {
  return (
    <li className="card-row" data-row="extractor" data-item={row.itemId}>
      <span className="card-row-name">
        {row.name} <span className="card-row-class">{row.class}</span>
      </span>
      <span className="card-row-figures">
        <Figure label="Required" value={q(row.required)} />
        <Figure label="Extractors" value={q(row.extractorCount)} />
        <Figure label="Depots" value={q(row.depots)} />
        <Figure label="Rate/s" value={q(row.ratePerSecond)} />
        <Duration label="Fill (s)" seconds={row.fillSeconds} />
        <RowProvenance verified={row.verified} />
      </span>
    </li>
  );
}

function RanchRowView({ row }: { row: RanchRow }): ReactNode {
  return (
    <li className="card-row" data-row="ranch" data-item={row.itemId}>
      <span className="card-row-name">{row.name}</span>
      <span className="card-row-figures">
        <Figure label="Required" value={q(row.required)} />
        <Figure label="Fauna" value={q(row.fauna)} />
        <Duration label="Cycle (s)" seconds={row.cycleSeconds} />
        <RowProvenance verified={row.verified} />
      </span>
    </li>
  );
}

function KitchenRowView({ row }: { row: KitchenStep }): ReactNode {
  return (
    <li className="card-row" data-row="kitchen" data-item={row.itemId}>
      <span className="card-row-name">
        {row.name} <span className="card-row-class">{row.recipe}</span>
      </span>
      <span className="card-row-figures">
        <Figure label="Required" value={q(row.required)} />
        <Duration label="Process (s)" seconds={row.processSeconds} />
        <RowProvenance verified={row.verified} />
      </span>
    </li>
  );
}

function NoBuildRowView({ row }: { row: NoBuildRow }): ReactNode {
  return (
    <li className="card-row" data-row="no-build" data-item={row.itemId}>
      <span className="card-row-name">{row.name}</span>
      <span className="card-row-figures">
        <Figure label="Demand" value={q(row.required)} />
        <Figure label="Covered by" value={row.from} />
        {/*
          A word, not a style. An omitted row is indistinguishable from an
          overlooked requirement, and a row distinguished only by being
          greyed out is indistinguishable to anyone not seeing the grey.
        */}
        <span className="card-nothing-to-build">Nothing to build</span>
        <RowProvenance verified={row.verified} />
      </span>
    </li>
  );
}

/** Base-level counts belong to a section, never to a row inside it. */
function sectionFigure(base: BaseBuild, kind: ProducerKind): ReactNode {
  if (kind === "kitchen") {
    return <Figure label="Nutrient processors" value={q(base.nutrientProcessors)} />;
  }
  if (kind === "ranch") {
    return <Figure label="Pellet feeders" value={q(base.pelletFeeders)} />;
  }
  return null;
}

function rowsFor(base: BaseBuild, kind: ProducerKind): ReactNode {
  switch (kind) {
    case "farm":
      return base.farms.map((row) => <FarmRowView key={row.itemId} row={row} />);
    case "extractor":
      return base.extractors.map((row) => (
        <ExtractorRowView key={row.itemId} row={row} />
      ));
    case "ranch":
      return base.ranches.map((row) => <RanchRowView key={row.itemId} row={row} />);
    case "kitchen":
      return base.kitchen.map((row) => <KitchenRowView key={row.itemId} row={row} />);
  }
}

export function BasePlannerCard({
  base,
  identity,
  selected = false,
  onSelect,
  configuration,
  onConfigure,
  budget,
}: BasePlannerCardProps): ReactNode {
  const kinds = presentKinds(base);
  const identityClass =
    identity === undefined ? "identity-unassigned" : `identity-${String(identity)}`;

  return (
    <article
      className={`card identity ${identityClass} selectable`}
      data-selected={selected ? "true" : "false"}
      data-base={base.base}
    >
      <header className="card-head">
        <h3 className="card-name">
          {/*
            A real button. SPEC-0007: "A generic element given a tab index
            MUST NOT be used" — the semantics are what a screen reader reads,
            and a div that behaves correctly still announces nothing. The
            base's name is the button's accessible name, which is also what
            makes the card identifiable with colour removed entirely.
          */}
          <button
            type="button"
            className="card-select interactive"
            aria-pressed={selected}
            onClick={() => onSelect?.(base.base)}
          >
            {base.base}
          </button>
        </h3>
        {identity === undefined ? (
          <StatusBadge status="warning" detail="no identity assigned" />
        ) : null}
        {/*
          The base's own provenance, not a summary of the rows'. The payload
          carries the two separately and the requirement forbids either
          standing in for the other.
        */}
        <BaseProvenance verified={base.verified} />
      </header>

      {configuration !== undefined && onConfigure !== undefined ? (
        <CardControls
          configuration={configuration}
          onConfigure={onConfigure}
          budget={budget}
        />
      ) : null}

      {kinds.map((kind) => (
        <section className="card-section" key={kind} data-section={kind}>
          <h4 className="card-section-head">
            {PRODUCER_HEADING[kind]}
            {sectionFigure(base, kind)}
          </h4>
          <ul className="card-rows">{rowsFor(base, kind)}</ul>
        </section>
      ))}

      {budget !== undefined ? (
        <PowerBlock budget={budget} emClass={configuration?.power.emClass} />
      ) : null}

      {base.noBuild.length > 0 ? (
        <section className="card-section" data-section="no-build">
          <h4 className="card-section-head">Covered by byproduct</h4>
          <ul className="card-rows">
            {base.noBuild.map((row) => (
              <NoBuildRowView key={row.itemId} row={row} />
            ))}
          </ul>
        </section>
      ) : null}

      {/*
        The footer is last because it is a rollup of what is above it. Its
        pending row exists only where the domain reported a deficit it could
        size — an unsized fix has no count to carry into the footer, and
        inventing one there would be the same error as offering it as an
        action.
      */}
      <BuildFooter
        items={buildItems(
          base,
          budget !== undefined && budget.inDeficit && !budget.fixUnsized
            ? {
                count: budget.additionalGenerators,
                unitType: "Electromagnetic generators",
              }
            : undefined,
        )}
      />
    </article>
  );
}
