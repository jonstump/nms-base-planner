/*
 * Plan state: the one shape that crosses in both directions, and the one
 * validation path everything goes through.
 *
 * Governing: ADR-0002 (plan state in the URL hash), ADR-0004 (React view
 * layer), SPEC-0005 REQ "Boundary Client", Security Requirements → Redirect
 * Validation, SPEC-0002 REQ "Recipe Selection Crossing"
 *
 * The URL hash is untrusted input — anyone can hand a user a link. SPEC-0005
 * requires it to "decode through the same path as any other plan input", so
 * {@link validatePlan} is the only way to make a Plan and the hash decoder
 * has no private route around it.
 */

import { asQuantity, type Quantity } from "./quantity";

export interface Plan {
  readonly target: string;
  readonly quantity: Quantity;
  /** Per-node method overrides. Absent means every node is on its default. */
  readonly methods: Readonly<Record<string, string>>;
  /** Per-node recipe overrides. */
  readonly recipes: Readonly<Record<string, string>>;
  /**
   * Leaf item id to base id.
   *
   * Plan state, and in the hash — SPEC-0011 REQ "The Hash Owns the Plan, the
   * Store Owns the Player" lists assignments alongside target, quantity,
   * methods and recipes as what a shared link carries. They are the one
   * field here that never reaches `resolve`: stage 1 does not see them, and
   * they cross to the domain on the stage-2 rollup request instead. See
   * `planToWire`.
   */
  readonly assignments: Readonly<Record<string, string>>;
}

/**
 * What a view holds before a target is chosen, and what an undecodable hash
 * produces. Never a partially-applied plan.
 */
export const EMPTY_PLAN: Plan = Object.freeze({
  target: "",
  quantity: "0" as Quantity,
  methods: Object.freeze({}),
  recipes: Object.freeze({}),
  assignments: Object.freeze({}),
});

export function isEmptyPlan(plan: Plan): boolean {
  return plan.target === "";
}

/*
 * Item and method identifiers in the artifact are upper-case ASCII with
 * digits and underscores. Bounding the character set here is what stops a
 * hash from carrying a `javascript:` payload into a field a later surface
 * might render as a link, and the length bound stops a link from being a
 * denial-of-service against the module.
 */
const IDENTIFIER = /^[A-Za-z0-9_.-]{1,64}$/;

export type PlanResult =
  | { readonly ok: true; readonly plan: Plan }
  | { readonly ok: false; readonly reason: string };

function reject(reason: string): PlanResult {
  return { ok: false, reason };
}

/*
 * A tagged result rather than "an object, or an object with a `reason` key".
 *
 * `reason` is a legal override key — IDENTIFIER admits it — so
 * `methods: { reason: "SMELT" }` would have been read as a rejection carrying
 * the reason "SMELT", silently discarding a valid plan and reporting
 * nonsense. Untrusted input decides the key set here, so the discriminant
 * cannot live inside it.
 */
type OverrideResult =
  | { readonly ok: true; readonly overrides: Record<string, string> }
  | { readonly ok: false; readonly reason: string };

function validateOverrides(value: unknown, field: string): OverrideResult {
  if (value === undefined || value === null) return { ok: true, overrides: {} };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: `${field} is not an object` };
  }

  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!IDENTIFIER.test(key))
      return { ok: false, reason: `${field} has an unusable key` };
    if (typeof entry !== "string" || !IDENTIFIER.test(entry)) {
      return { ok: false, reason: `${field}[${key}] is not a usable identifier` };
    }
    out[key] = entry;
  }
  return { ok: true, overrides: out };
}

/**
 * The single gate. Every plan — typed in, restored from a hash, or round
 * tripped through the module — arrives through here.
 */
export function validatePlan(value: unknown): PlanResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return reject("plan state is not an object");
  }
  const raw = value as Record<string, unknown>;

  const target = raw["target"];
  if (typeof target !== "string" || !IDENTIFIER.test(target)) {
    return reject("target is not a usable item identifier");
  }

  const quantity = asQuantity(raw["quantity"]);
  if (quantity === null) return reject("quantity is not an exact quantity");
  if (quantity.startsWith("-")) return reject("quantity is negative");

  const methods = validateOverrides(raw["methods"], "methods");
  if (!methods.ok) return reject(methods.reason);

  const recipes = validateOverrides(raw["recipes"], "recipes");
  if (!recipes.ok) return reject(recipes.reason);

  const assignments = validateOverrides(raw["assignments"], "assignments");
  if (!assignments.ok) return reject(assignments.reason);

  /*
   * Only these five fields are read. A hash carrying `ticks`, `notes` or a
   * place name is not rejected — it is *ignored*, and the value never
   * reaches a Plan. SPEC-0011 forbids a hash-derived value being written to
   * the store as though the player authored it, and the cheapest way to
   * honour that is for the decoder to have nowhere to put one.
   */
  return {
    ok: true,
    plan: {
      target,
      quantity,
      methods: methods.overrides,
      recipes: recipes.overrides,
      assignments: assignments.overrides,
    },
  };
}

/** The wire shape internal/bridge parses, with omitempty honoured. */
export function planToWire(plan: Plan): string {
  const wire: Record<string, unknown> = { target: plan.target, quantity: plan.quantity };
  if (Object.keys(plan.methods).length > 0) wire["methods"] = plan.methods;
  if (Object.keys(plan.recipes).length > 0) wire["recipes"] = plan.recipes;
  /*
   * `assignments` is deliberately absent.
   *
   * This is the wire shape `resolve` parses, and stage 1 has no concept of a
   * base — `internal/bridge.Plan` carries target, quantity, methods and
   * recipes and nothing else. Assignments reach the domain on the stage-2
   * rollup request, which is where the domain reads them.
   *
   * Sending them anyway would be harmless today (the Go decoder ignores
   * unknown fields on a plan) and wrong in the way that matters: it would
   * say stage 1 takes an input it does not take.
   */
  return JSON.stringify(wire);
}
