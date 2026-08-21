/*
 * The resolved graph, decoded without arithmetic.
 *
 * Governing: ADR-0004 (React view layer), SPEC-0005 REQ "The View Computes
 * No Domain Values", SPEC-0002 REQ "Exact Quantity Encoding"
 *
 * Every quantity stays the string the module sent. `asQuantity` validates the
 * shape and returns the same characters; it does not parse. A decode that
 * cannot validate a quantity rejects the whole payload rather than dropping
 * the field, because a graph missing one total renders as a plan that costs
 * less than it does.
 */

import { asQuantity, type Quantity } from "./quantity";

export interface ResolvedEdge {
  readonly to: string;
  readonly perUnit: Quantity;
  readonly yield: Quantity;
}

export interface ResolvedNode {
  readonly itemId: string;
  readonly name: string;
  readonly total: Quantity;
  readonly method: string;
  readonly legalMethods: readonly string[];
  readonly recipe: string | null;
  readonly legalRecipes: readonly string[];
  readonly yield: Quantity | null;
  readonly applications: Quantity | null;
  readonly terminal: boolean;
  readonly verified: boolean;
  readonly children: readonly ResolvedEdge[];
}

export interface ResolvedGraph {
  readonly target: string;
  readonly quantity: Quantity;
  readonly gameVersion: string;
  /** The domain's order: terminals first, target last (SPEC-0002). */
  readonly nodes: readonly ResolvedNode[];
}

type Raw = Record<string, unknown>;

function object(value: unknown): Raw | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Raw)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function textList(value: unknown): readonly string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    out.push(entry);
  }
  return out;
}

/** An omitempty field: absent is fine, present-and-wrong is not. */
function optionalQuantity(
  value: unknown,
): { ok: true; value: Quantity | null } | { ok: false } {
  if (value === undefined || value === "") return { ok: true, value: null };
  const quantity = asQuantity(value);
  return quantity === null ? { ok: false } : { ok: true, value: quantity };
}

function decodeEdge(value: unknown): ResolvedEdge | null {
  const raw = object(value);
  if (!raw) return null;

  const to = text(raw["to"]);
  const perUnit = asQuantity(raw["perUnit"]);
  const yieldValue = asQuantity(raw["yield"]);
  if (to === null || perUnit === null || yieldValue === null) return null;

  return { to, perUnit, yield: yieldValue };
}

function decodeNode(value: unknown): ResolvedNode | null {
  const raw = object(value);
  if (!raw) return null;

  const itemId = text(raw["itemId"]);
  const name = text(raw["name"]);
  const total = asQuantity(raw["total"]);
  const method = text(raw["method"]);
  const legalMethods = textList(raw["legalMethods"]);
  const legalRecipes = textList(raw["legalRecipes"]);
  if (itemId === null || name === null || total === null || method === null) return null;
  if (legalMethods === null || legalRecipes === null) return null;

  const yieldValue = optionalQuantity(raw["yield"]);
  const applications = optionalQuantity(raw["applications"]);
  if (!yieldValue.ok || !applications.ok) return null;

  const children: ResolvedEdge[] = [];
  const rawChildren = raw["children"];
  if (rawChildren !== undefined) {
    if (!Array.isArray(rawChildren)) return null;
    for (const entry of rawChildren) {
      const edge = decodeEdge(entry);
      if (edge === null) return null;
      children.push(edge);
    }
  }

  return {
    itemId,
    name,
    total,
    method,
    legalMethods,
    recipe: text(raw["recipe"]),
    legalRecipes,
    yield: yieldValue.value,
    applications: applications.value,
    terminal: raw["terminal"] === true,
    verified: raw["verified"] === true,
    children,
  };
}

/** Pull `data.graph` out of a result payload, or return null. */
export function selectGraph(data: unknown): ResolvedGraph | null {
  const payload = object(data);
  const raw = payload === null ? null : object(payload["graph"]);
  if (!raw) return null;

  const target = text(raw["target"]);
  const quantity = asQuantity(raw["quantity"]);
  const gameVersion = text(raw["gameVersion"]);
  if (target === null || quantity === null || gameVersion === null) return null;

  const rawNodes = raw["nodes"];
  if (!Array.isArray(rawNodes)) return null;

  const nodes: ResolvedNode[] = [];
  for (const entry of rawNodes) {
    const node = decodeNode(entry);
    if (node === null) return null;
    nodes.push(node);
  }

  return { target, quantity, gameVersion, nodes };
}
