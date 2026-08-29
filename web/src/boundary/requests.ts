/*
 * What the view sends to stages 2 and 3.
 *
 * Governing: ADR-0004 (React view layer), SPEC-0002 REQ "Exact Quantity
 * Encoding", SPEC-0001 design.md "Tier 2 constants injected, never
 * hardcoded"
 *
 * Every scalar is a quantity string for the same reason node totals are: a
 * count that crosses as a JSON number has left the exactness contract. The
 * curated constants cross with the request rather than living in the module
 * because the engine refuses to default any of them and names the one it is
 * missing — a guarantee that only holds if the view never invents one.
 *
 * These are request shapes, not domain values. The view assembles them from
 * plan state and player configuration; it computes none of them.
 */

import type { Plan } from "./plan";
import type { Quantity } from "./quantity";

/** The Tier 2 constant set. The engine defaults none of it. */
export interface Curated {
  readonly biodomeCropSlots: Quantity;
  readonly faunaYieldPerCycle: Quantity;
  readonly faunaCycleSeconds: Quantity;
  readonly stepsPerProcessor: Quantity;
  readonly depotThreshold: Quantity;
  readonly processSeconds: Quantity;
  readonly panelsPerBattery: Quantity;
  /** Which leaves come from creatures. */
  readonly faunaProducts?: readonly string[];
  /** Which hotspot category each extracted resource sits on. */
  readonly resourceHotspots?: Readonly<Record<string, string>>;

  /*
   * The date each curated constant was confirmed in game, keyed by the
   * domain's constant names ("biodome crop slots", "panels per battery", and
   * the five others above).
   *
   * Optional, and absence is the meaningful case: the engine reads a
   * constant as unverified when this map has no entry for it, and taints
   * every figure derived from it. So omitting this field is not "no
   * provenance information" — it is the claim that nothing has been
   * confirmed, which is the honest state of this project's curated set
   * today and the reason every producer row currently returns
   * `verified: false`.
   *
   * It is here so that state can change. Without it the view can read
   * provenance and never influence it, which makes the flag it decodes
   * permanently false rather than merely false for now.
   *
   * Governing: SPEC-0001 REQ "Provenance Propagation" — Scenario
   * "Unverified constant taints producer count".
   */
  readonly verifiedOn?: Readonly<Record<string, string>>;
}

export interface SiteConfig {
  readonly extractorClass: string;
  readonly fillSeconds: Quantity;
}

export interface ByproductSource {
  readonly item: string;
  readonly from: string;
}

export interface KitchenStepRequest {
  readonly itemId: string;
  readonly recipe: string;
  readonly quantity: Quantity;
}

export interface RollupRequest {
  readonly plan: Plan;
  readonly assignments?: Readonly<Record<string, string>>;
  readonly sites?: Readonly<Record<string, SiteConfig>>;
  readonly byproducts?: Readonly<Record<string, readonly ByproductSource[]>>;
  readonly kitchen?: Readonly<Record<string, readonly KitchenStepRequest[]>>;
  readonly constants: Curated;
}

/**
 * One base's generation setup.
 *
 * Three independent values, not a choice between two modes. The domain
 * models them that way — a base may run both — and SPEC-0007 REQ "Power
 * Configuration Supports Mixed Sources" requires the view to be able to
 * express it. Solar carries no class, because the domain's solar output is
 * classless and offering one would imply a computation it does not perform.
 */
export interface PowerGeneration {
  readonly emGenerators?: Quantity;
  readonly emClass?: string;
  readonly solarPanels?: Quantity;
}

/** A count of one buildable drawing power at a base. */
export interface PowerUnit {
  readonly partId: string;
  readonly count: Quantity;
}

export interface PowerRequest {
  readonly sources?: Readonly<Record<string, PowerGeneration>>;
  readonly draws?: Readonly<Record<string, readonly PowerUnit[]>>;
  /**
   * The bases whose contributing figures are not verified.
   *
   * A list rather than a map to boolean: the set is what is meant, and a
   * map with false values would encode a distinction that is not one.
   */
  readonly unverified?: readonly string[];
  readonly constants: Curated;
}

/*
 * The wire encoders.
 *
 * `JSON.stringify` drops undefined keys, which is exactly the omitempty
 * behaviour the Go side expects — an absent optional means "not configured",
 * and the engine names any constant it needed and did not get.
 */

export function rollupToWire(request: RollupRequest): string {
  return JSON.stringify(request);
}

export function powerToWire(request: PowerRequest): string {
  return JSON.stringify(request);
}
