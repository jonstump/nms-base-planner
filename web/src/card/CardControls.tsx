import { useId, type ReactNode } from "react";

import { formatQuantity, type PowerBudget } from "../boundary";

import {
  HOTSPOT_CLASSES,
  WEAKEST_CLASS,
  hasSolar,
  withEmClass,
  withEmGenerators,
  withExtractorClass,
  withFillSeconds,
  withSolarPanels,
  type CardConfiguration,
} from "./configuration";

/*
 * The card's two configuration surfaces.
 *
 * Governing: ADR-0004 (React view layer), SPEC-0007 REQ "Site Configuration",
 * REQ "Power Configuration Supports Mixed Sources", SPEC-0005 REQ "Component
 * Styling Discipline", Accessibility Requirements
 *
 * Both are per-card. The extractor class is a site control and not a row one
 * because extractors at one base share a hotspot: a per-row class would let
 * the view express a configuration the domain cannot model, and the card
 * would then be showing a plan the engine would never produce.
 *
 * Every change here goes out through `onConfigure` and comes back as new
 * payload. Nothing adjusts a count, a fill time or a draw figure in place —
 * SPEC-0005 forbids the arithmetic, and #82's frozen ResultCache would throw
 * rather than let an in-place edit pass quietly.
 *
 * The controls follow ViewPreferences' idiom: a real labelled input per
 * value, `.control` for the scale, `.interactive` for the hover and focus
 * treatments. Nothing here re-implements a focus ring.
 */

export interface CardControlsProps {
  readonly configuration: CardConfiguration;
  readonly onConfigure: (next: CardConfiguration) => void;
  /** Stage 3's answer for this base, where one has been computed. */
  readonly budget?: PowerBudget | undefined;
}

/** A class picker. Extractors and generators pick from the same domain set. */
function ClassSelect({
  label,
  value,
  onPick,
  testid,
}: {
  label: string;
  value: string;
  onPick: (next: string) => void;
  testid: string;
}): ReactNode {
  const id = useId();
  return (
    <div className="control-row-sm">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        className="control control-sm interactive"
        data-testid={testid}
        value={value}
        onChange={(event) => {
          onPick(event.target.value);
        }}
      >
        {/*
          An unconfigured site shows that it is unconfigured.

          Governing: SPEC-0011 REQ "A Place Is Creatable by Hand", SPEC-0007
          REQ "Absent Data Is Absent"

          Without this option a select whose value matches nothing falls back
          to its first option, so a place created with a name and nothing
          else would read as configured at class C — a value the player never
          chose, which is exactly what the requirement rules out.

          Offered only while the value is empty. Once a class is picked,
          "un-configure" is not an operation the payload models, and an
          option that cannot be honoured is worse than one that is absent.
        */}
        {value === "" && (
          <option value="" disabled>
            Not configured
          </option>
        )}
        {HOTSPOT_CLASSES.map((cls) => (
          <option key={cls} value={cls}>
            {cls}
          </option>
        ))}
      </select>
    </div>
  );
}

/*
 * A count entry.
 *
 * The value crosses as an exact string and is validated by `asQuantity` in
 * the updater, which returns null rather than coercing. A rejected entry
 * leaves the configuration alone: the control holds what the player typed
 * and no boundary call goes out for a value the engine would refuse.
 */
function QuantityEntry({
  label,
  value,
  onEnter,
  testid,
}: {
  label: string;
  value: string;
  onEnter: (raw: string) => void;
  testid: string;
}): ReactNode {
  const id = useId();
  return (
    <div className="control-row-sm">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        min="0"
        step="1"
        inputMode="numeric"
        className="control control-sm interactive card-entry"
        data-testid={testid}
        value={value}
        onChange={(event) => {
          onEnter(event.target.value);
        }}
      />
    </div>
  );
}

export function CardControls({
  configuration,
  onConfigure,
  budget,
}: CardControlsProps): ReactNode {
  const { site, power } = configuration;

  /** Applies an updater that may reject the entry. */
  const apply = (next: CardConfiguration | null): void => {
    if (next !== null) onConfigure(next);
  };

  return (
    <div className="card-config">
      <fieldset className="card-fieldset" data-config="site">
        <legend className="label">Site</legend>
        {/*
          One class control for the whole card. A base with three extractor
          rows has exactly one of these, and no row carries its own.
        */}
        <ClassSelect
          label="Extractor class"
          value={site.extractorClass}
          testid="extractor-class"
          onPick={(cls) => {
            onConfigure(withExtractorClass(configuration, cls));
          }}
        />
        {/*
          Exposed, not implied. Extractor counts are sized to this duration,
          and a count shown without the patience it assumes is not something
          a player can act on.
        */}
        <QuantityEntry
          label="Fill duration (s)"
          value={site.fillSeconds}
          testid="fill-seconds"
          onEnter={(raw) => {
            apply(withFillSeconds(configuration, raw));
          }}
        />
      </fieldset>

      <fieldset className="card-fieldset" data-config="power">
        <legend className="label">Generation</legend>
        {/*
          Three independent values, not a mode switch. A base may run
          electromagnetic generators and solar panels together, and the
          domain computes that; an EM-or-solar toggle cannot express it.
        */}
        <QuantityEntry
          label="EM generators"
          value={power.emGenerators ?? ""}
          testid="em-generators"
          onEnter={(raw) => {
            apply(withEmGenerators(configuration, raw));
          }}
        />
        <ClassSelect
          label="Generator class"
          value={power.emClass ?? WEAKEST_CLASS}
          testid="em-class"
          onPick={(cls) => {
            onConfigure(withEmClass(configuration, cls));
          }}
        />
        <QuantityEntry
          label="Solar panels"
          value={power.solarPanels ?? ""}
          testid="solar-panels"
          onEnter={(raw) => {
            apply(withSolarPanels(configuration, raw));
          }}
        />
        {/*
          No solar class control, anywhere. The domain's solar output is
          classless and a picker here would imply a computation it does not
          perform. There is also no field to write one into.

          Batteries are the domain's count for night coverage, shown because
          solar is configured and read from the payload rather than derived
          from the panel count.
        */}
        {hasSolar(configuration) && budget !== undefined ? (
          <p className="card-batteries">
            <span className="card-figure-label">Batteries</span>{" "}
            <span className="card-figure-value mono" data-testid="batteries">
              {formatQuantity(budget.batteries)}
            </span>
          </p>
        ) : null}
      </fieldset>
    </div>
  );
}
