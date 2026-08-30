/*
 * The stage 2 build payload: one base's construction instructions.
 *
 * Governing: ADR-0004 (React view layer), SPEC-0002 REQ "Exact Quantity
 * Encoding", SPEC-0005 REQ "The View Computes No Domain Values",
 * SPEC-0007 REQ "Card Composition From the Build Payload"
 *
 * Every count here is the domain's — plants, biodomes, extractors, depots,
 * fauna, nutrient processors, pellet feeders. SPEC-0007 forbids the view
 * computing any of them from a quantity and a rate even when both are in
 * the payload, so they arrive as exact strings and stay that way.
 *
 * Two fields exist because omitting them would lose a planning result:
 * `noBuild` carries demands a byproduct already covers, and `unassigned`
 * carries leaves the plan places nowhere. An absent row is indistinguishable
 * from an overlooked requirement.
 */

import { flag, list, object, quantity, text, type Raw } from "./decode";
import type { Quantity } from "./quantity";

export interface YieldRange {
  readonly min: Quantity;
  readonly max: Quantity;
}

export interface FarmRow {
  readonly itemId: string;
  readonly name: string;
  readonly required: Quantity;
  readonly plants: Quantity;
  readonly biodomes: Quantity;
  /** Both bounds. The domain sizes plants on the pessimistic one. */
  readonly yieldPerPlant: YieldRange;
  readonly growthSeconds: Quantity;
  readonly verified: boolean;
}

export interface ExtractorRow {
  readonly itemId: string;
  readonly name: string;
  readonly class: string;
  readonly required: Quantity;
  readonly extractorCount: Quantity;
  readonly depots: Quantity;
  readonly ratePerSecond: Quantity;
  /** What the built extractors actually take — at most the configured duration. */
  readonly fillSeconds: Quantity;
  readonly verified: boolean;
}

export interface RanchRow {
  readonly itemId: string;
  readonly name: string;
  readonly required: Quantity;
  readonly fauna: Quantity;
  readonly cycleSeconds: Quantity;
  readonly verified: boolean;
}

export interface KitchenInput {
  readonly itemId: string;
  readonly perOutput: Quantity;
}

export interface KitchenStep {
  readonly itemId: string;
  readonly name: string;
  readonly recipe: string;
  readonly required: Quantity;
  readonly processSeconds: Quantity;
  readonly final: boolean;
  readonly verified: boolean;
  readonly inputs: readonly KitchenInput[];
}

/** A demand a byproduct at the same base already covers. */
export interface NoBuildRow {
  readonly itemId: string;
  readonly name: string;
  readonly from: string;
  readonly required: Quantity;
  readonly verified: boolean;
}

export interface Site {
  readonly extractorClass: string;
  readonly fillSeconds: Quantity;
}

/**
 * A demand needing extraction at a base with no site configuration.
 *
 * Governing: SPEC-0011 REQ "A Place Is Creatable by Hand", SPEC-0007 REQ
 * "Absent Data Is Absent"
 *
 * The requirement is still known; what is missing is the class and the fill
 * duration that would size it. A row rather than a flag, so a surface can
 * name what is waiting rather than only that something is.
 */
export interface UnsitedRow {
  readonly itemId: string;
  readonly name: string;
  readonly required: Quantity;
  readonly verified: boolean;
}

export interface BaseBuild {
  readonly base: string;
  readonly site: Site;
  /**
   * Whether this base has a site configuration.
   *
   * Governing: SPEC-0011 REQ "A Place Is Creatable by Hand"
   *
   * Read this before reading `site`. When false the site's values are zeros
   * that mean nothing, and a surface MUST render the absence rather than
   * the zeros — a class of "" shown as a class, or a fill duration of 0
   * shown as a duration, is the configured-value-of-zero the requirement
   * rules out.
   */
  readonly configured: boolean;
  readonly farms: readonly FarmRow[];
  readonly extractors: readonly ExtractorRow[];
  readonly ranches: readonly RanchRow[];
  readonly kitchen: readonly KitchenStep[];
  /** Per base, not per row. Summing a per-row figure would overcount. */
  readonly nutrientProcessors: Quantity;
  readonly pelletFeeders: Quantity;
  readonly noBuild: readonly NoBuildRow[];
  /** Demands awaiting a site configuration. Always empty when `configured`. */
  readonly unsited: readonly UnsitedRow[];
  /** The base-level answer: every row here, and the constant that sized its processors. */
  readonly verified: boolean;
}

export interface Demand {
  readonly itemId: string;
  readonly name: string;
  readonly total: Quantity;
  readonly verified: boolean;
}

export interface Build {
  readonly bases: readonly BaseBuild[];
  /** Leaves the plan places nowhere. Reported rather than lost silently. */
  readonly unassigned: readonly Demand[];
}

function decodeYieldRange(value: unknown): YieldRange | null {
  const raw = object(value);
  if (!raw) return null;
  const min = quantity(raw["min"]);
  const max = quantity(raw["max"]);
  return min === null || max === null ? null : { min, max };
}

function decodeFarm(value: unknown): FarmRow | null {
  const raw = object(value);
  if (!raw) return null;

  const itemId = text(raw["itemId"]);
  const name = text(raw["name"]);
  const required = quantity(raw["required"]);
  const plants = quantity(raw["plants"]);
  const biodomes = quantity(raw["biodomes"]);
  const growthSeconds = quantity(raw["growthSeconds"]);
  const yieldPerPlant = decodeYieldRange(raw["yieldPerPlant"]);
  const verified = flag(raw["verified"]);

  if (itemId === null || name === null || required === null) return null;
  if (plants === null || biodomes === null || growthSeconds === null) return null;
  if (yieldPerPlant === null || verified === null) return null;

  return {
    itemId,
    name,
    required,
    plants,
    biodomes,
    yieldPerPlant,
    growthSeconds,
    verified,
  };
}

function decodeExtractor(value: unknown): ExtractorRow | null {
  const raw = object(value);
  if (!raw) return null;

  const itemId = text(raw["itemId"]);
  const name = text(raw["name"]);
  const rowClass = text(raw["class"]);
  const required = quantity(raw["required"]);
  const extractorCount = quantity(raw["extractorCount"]);
  const depots = quantity(raw["depots"]);
  const ratePerSecond = quantity(raw["ratePerSecond"]);
  const fillSeconds = quantity(raw["fillSeconds"]);
  const verified = flag(raw["verified"]);

  if (itemId === null || name === null || rowClass === null || required === null)
    return null;
  if (extractorCount === null || depots === null) return null;
  if (ratePerSecond === null || fillSeconds === null || verified === null) return null;

  return {
    itemId,
    name,
    class: rowClass,
    required,
    extractorCount,
    depots,
    ratePerSecond,
    fillSeconds,
    verified,
  };
}

function decodeRanch(value: unknown): RanchRow | null {
  const raw = object(value);
  if (!raw) return null;

  const itemId = text(raw["itemId"]);
  const name = text(raw["name"]);
  const required = quantity(raw["required"]);
  const fauna = quantity(raw["fauna"]);
  const cycleSeconds = quantity(raw["cycleSeconds"]);
  const verified = flag(raw["verified"]);

  if (itemId === null || name === null || required === null) return null;
  if (fauna === null || cycleSeconds === null || verified === null) return null;

  return { itemId, name, required, fauna, cycleSeconds, verified };
}

function decodeKitchenInput(value: unknown): KitchenInput | null {
  const raw = object(value);
  if (!raw) return null;
  const itemId = text(raw["itemId"]);
  const perOutput = quantity(raw["perOutput"]);
  return itemId === null || perOutput === null ? null : { itemId, perOutput };
}

function decodeKitchen(value: unknown): KitchenStep | null {
  const raw = object(value);
  if (!raw) return null;

  const itemId = text(raw["itemId"]);
  const name = text(raw["name"]);
  const recipe = text(raw["recipe"]);
  const required = quantity(raw["required"]);
  const processSeconds = quantity(raw["processSeconds"]);
  const final = flag(raw["final"]);
  const verified = flag(raw["verified"]);
  const inputs = list(raw["inputs"], decodeKitchenInput);

  if (itemId === null || name === null || recipe === null || required === null)
    return null;
  if (processSeconds === null || final === null || verified === null || inputs === null)
    return null;

  return { itemId, name, recipe, required, processSeconds, final, verified, inputs };
}

function decodeNoBuild(value: unknown): NoBuildRow | null {
  const raw = object(value);
  if (!raw) return null;

  const itemId = text(raw["itemId"]);
  const name = text(raw["name"]);
  const from = text(raw["from"]);
  const required = quantity(raw["required"]);
  const verified = flag(raw["verified"]);

  if (itemId === null || name === null || from === null) return null;
  if (required === null || verified === null) return null;

  return { itemId, name, from, required, verified };
}

function decodeUnsited(value: unknown): UnsitedRow | null {
  const raw = object(value);
  if (!raw) return null;

  const itemId = text(raw["itemId"]);
  const name = text(raw["name"]);
  const required = quantity(raw["required"]);
  const verified = flag(raw["verified"]);

  if (itemId === null || name === null) return null;
  if (required === null || verified === null) return null;

  return { itemId, name, required, verified };
}

function decodeSite(value: unknown): Site | null {
  const raw = object(value);
  if (!raw) return null;
  const extractorClass = text(raw["extractorClass"]);
  const fillSeconds = quantity(raw["fillSeconds"]);
  return extractorClass === null || fillSeconds === null
    ? null
    : { extractorClass, fillSeconds };
}

function decodeDemand(value: unknown): Demand | null {
  const raw = object(value);
  if (!raw) return null;
  const itemId = text(raw["itemId"]);
  const name = text(raw["name"]);
  const total = quantity(raw["total"]);
  const verified = flag(raw["verified"]);
  if (itemId === null || name === null || total === null || verified === null)
    return null;
  return { itemId, name, total, verified };
}

function decodeBase(value: unknown): BaseBuild | null {
  const raw = object(value);
  if (!raw) return null;

  const base = text(raw["base"]);
  const site = decodeSite(raw["site"]);
  const farms = list(raw["farms"], decodeFarm);
  const extractors = list(raw["extractors"], decodeExtractor);
  const ranches = list(raw["ranches"], decodeRanch);
  const kitchen = list(raw["kitchen"], decodeKitchen);
  const noBuild = list(raw["noBuild"], decodeNoBuild);
  const unsited = list(raw["unsited"], decodeUnsited);
  const nutrientProcessors = quantity(raw["nutrientProcessors"]);
  const pelletFeeders = quantity(raw["pelletFeeders"]);
  const verified = flag(raw["verified"]);
  /*
   * Required rather than defaulted. A payload without the key is a module
   * older than contract 1.3.0, and guessing `true` would present an
   * unconfigured base's zeros as a configuration — which is the one thing
   * SPEC-0011 asks this field to prevent. Failing the decode routes it to
   * the version-mismatch path instead.
   */
  const configured = flag(raw["configured"]);

  if (base === null || site === null || configured === null) return null;
  if (farms === null || extractors === null || ranches === null) return null;
  if (kitchen === null || noBuild === null || unsited === null) return null;
  if (nutrientProcessors === null || pelletFeeders === null || verified === null)
    return null;

  return {
    base,
    site,
    configured,
    farms,
    extractors,
    ranches,
    kitchen,
    nutrientProcessors,
    pelletFeeders,
    noBuild,
    unsited,
    verified,
  };
}

/** Pull `data.build` out of a result payload, or return null. */
export function selectBuild(data: unknown): Build | null {
  const payload = object(data);
  const raw: Raw | null = payload === null ? null : object(payload["build"]);
  if (!raw) return null;

  if (!Array.isArray(raw["bases"])) return null;
  const bases = list(raw["bases"], decodeBase);
  const unassigned = list(raw["unassigned"], decodeDemand);
  if (bases === null || unassigned === null) return null;

  return { bases, unassigned };
}
