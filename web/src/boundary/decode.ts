/*
 * The decode primitives every payload shares.
 *
 * Governing: ADR-0004 (React view layer), SPEC-0002 REQ "Exact Quantity
 * Encoding", SPEC-0005 REQ "The View Computes No Domain Values"
 *
 * Extracted from graph.ts when the build and power payloads arrived rather
 * than copied into them. Three decoders with three private copies of
 * `optionalQuantity` is three places for the omitempty rule to drift, and
 * the rule is the same everywhere: absent is fine, present-and-wrong is not.
 *
 * Nothing here parses a quantity. `asQuantity` validates the shape and hands
 * back the same characters; a payload that does not validate is rejected
 * whole rather than repaired, because a build missing one figure reads as a
 * build that costs less than it does.
 */

import { asQuantity, type Quantity } from "./quantity";

export type Raw = Record<string, unknown>;

export function object(value: unknown): Raw | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Raw)
    : null;
}

export function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function textList(value: unknown): readonly string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    out.push(entry);
  }
  return out;
}

/**
 * A required quantity.
 *
 * Distinct from {@link optionalQuantity}: a field the wire always sends is
 * missing rather than absent when it is not there, and treating the two the
 * same is how a zero gets substituted for a figure the domain reported.
 */
export function quantity(value: unknown): Quantity | null {
  return asQuantity(value);
}

/** An omitempty field: absent is fine, present-and-wrong is not. */
export function optionalQuantity(
  value: unknown,
): { ok: true; value: Quantity | null } | { ok: false } {
  if (value === undefined || value === "") return { ok: true, value: null };
  const parsed = asQuantity(value);
  return parsed === null ? { ok: false } : { ok: true, value: parsed };
}

/**
 * A boolean field.
 *
 * Strict rather than truthy. `verified` and `fixUnsized` both carry meaning
 * in their false case, and coercing an absent field to false would report a
 * definite answer the payload did not give.
 */
export function flag(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/**
 * Decode a list whose absence means empty, rejecting the whole list if any
 * element fails.
 *
 * The all-or-nothing rule applied one level down. A row that cannot be read
 * is not a row to skip: it is a payload this view does not understand.
 */
export function list<T>(
  value: unknown,
  decode: (entry: unknown) => T | null,
): T[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const out: T[] = [];
  for (const entry of value) {
    const decoded = decode(entry);
    if (decoded === null) return null;
    out.push(decoded);
  }
  return out;
}
