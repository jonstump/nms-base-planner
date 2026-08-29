/*
 * One base's configuration: its site, and its generation setup.
 *
 * Governing: ADR-0004 (React view layer), SPEC-0007 REQ "Site Configuration",
 * REQ "Power Configuration Supports Mixed Sources", SPEC-0005 REQ "The View
 * Computes No Domain Values"
 *
 * Both shapes are the boundary's own request types, re-exported rather than
 * redefined: `SiteConfig` and `PowerGeneration` already exist in
 * src/boundary/requests.ts, and a second copy here would be one refactor away
 * from disagreeing with the wire format the engine reads.
 *
 * `PowerGeneration` carries `emGenerators`, `emClass` and `solarPanels` as
 * three independent optional fields, which is the whole of REQ "Power
 * Configuration Supports Mixed Sources" expressed in a type: a base running
 * both sources is representable, and there is no field in which a mode could
 * be recorded. The prototype's EM-or-solar toggle could not express it, and
 * the handoff's own open questions concede the point.
 *
 * Nothing in this module reads a quantity's value. Configuration is carried,
 * not computed.
 */

import { asQuantity, type PowerGeneration, type SiteConfig } from "../boundary";

/**
 * The hotspot classes the domain accepts, weakest first.
 *
 * `internal/domain/rollup.go` defines C, B, A and S and rejects anything
 * else. Exported so a test enumerates the set rather than sampling it, and so
 * the extractor and generator controls offer the same list — they are the
 * same `HotspotClass` on the Go side, and two lists here would drift.
 */
export const WEAKEST_CLASS = "C";
export const HOTSPOT_CLASSES: readonly string[] = [WEAKEST_CLASS, "B", "A", "S"];

export interface CardConfiguration {
  readonly site: SiteConfig;
  readonly power: PowerGeneration;
}

/*
 * The updaters below return a new configuration and never mutate one. Each
 * takes the raw control value as a string and validates it through
 * `asQuantity`, which parses without arithmetic: an exact string passes
 * through unchanged and anything else is rejected rather than coerced.
 */

export function withExtractorClass(
  configuration: CardConfiguration,
  extractorClass: string,
): CardConfiguration {
  return { ...configuration, site: { ...configuration.site, extractorClass } };
}

/** Returns null when the entry is not an exact quantity, so the caller can hold. */
export function withFillSeconds(
  configuration: CardConfiguration,
  raw: string,
): CardConfiguration | null {
  const fillSeconds = asQuantity(raw);
  if (fillSeconds === null) return null;
  return { ...configuration, site: { ...configuration.site, fillSeconds } };
}

export function withEmClass(
  configuration: CardConfiguration,
  emClass: string,
): CardConfiguration {
  return { ...configuration, power: { ...configuration.power, emClass } };
}

export function withEmGenerators(
  configuration: CardConfiguration,
  raw: string,
): CardConfiguration | null {
  const emGenerators = asQuantity(raw);
  if (emGenerators === null) return null;
  return { ...configuration, power: { ...configuration.power, emGenerators } };
}

export function withSolarPanels(
  configuration: CardConfiguration,
  raw: string,
): CardConfiguration | null {
  const solarPanels = asQuantity(raw);
  if (solarPanels === null) return null;
  return { ...configuration, power: { ...configuration.power, solarPanels } };
}

/*
 * Solar has no `withSolarClass`, and its absence is the requirement rather
 * than an omission: "Solar MUST NOT be presented as carrying a class. The
 * domain's solar output is classless, and offering a class control for it
 * would imply a computation it does not perform." There is no field on
 * PowerGeneration to write one into either, so the rule is kept by the shape
 * and not only by the control set.
 */

/** True where the player has configured any solar at this base. */
export function hasSolar(configuration: CardConfiguration): boolean {
  return configuration.power.solarPanels !== undefined;
}
