/*
 * Plan state in the URL hash.
 *
 * Governing: ADR-0002 (plan state in the URL hash), SPEC-0005 Security
 * Requirements → Redirect Validation, REQ "Boundary Client"
 *
 * "Plan state arrives in the URL hash and is untrusted input: it MUST decode
 * through the same path as any other plan input, and a hash that cannot be
 * decoded MUST produce an empty plan and a diagnostic rather than a
 * partially-applied one. The application MUST NOT navigate to a URL taken
 * from decoded state."
 *
 * The partial-application clause is the one that shapes the code. It is
 * tempting to keep whichever fields parsed and drop the rest, and the result
 * is a user looking at a plan that is not the one in their link and not the
 * one they last had. There is one return path for every failure and it
 * returns EMPTY_PLAN.
 *
 * Nothing here reads or writes `location`. The decoder takes a string and the
 * encoder returns one; navigation belongs to the shell, and keeping the
 * decoded value away from anything that can navigate is how the second clause
 * is kept rather than promised.
 */

import { EMPTY_PLAN, validatePlan, type Plan } from "./plan";

/** The hash parameter the plan travels in. */
const PARAMETER = "p";

export interface DecodedHash {
  readonly plan: Plan;
  /**
   * Present when the hash could not be used. The plan is EMPTY_PLAN whenever
   * this is set — never a partly-applied one.
   */
  readonly diagnostic: string | null;
}

const CLEAN: DecodedHash = { plan: EMPTY_PLAN, diagnostic: null };

function unusable(diagnostic: string): DecodedHash {
  return { plan: EMPTY_PLAN, diagnostic };
}

/* base64url, so a plan survives a URL without percent-encoding. */

function toBase64Url(text: string): string {
  const utf8 = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of utf8) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(encoded: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  const padded = encoded.replaceAll("-", "+").replaceAll("_", "/");
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function encodePlanToHash(plan: Plan): string {
  const wire: Record<string, unknown> = { target: plan.target, quantity: plan.quantity };
  if (Object.keys(plan.methods).length > 0) wire["methods"] = plan.methods;
  if (Object.keys(plan.recipes).length > 0) wire["recipes"] = plan.recipes;
  return `#${PARAMETER}=${toBase64Url(JSON.stringify(wire))}`;
}

/**
 * Decode a location hash into a plan.
 *
 * An absent parameter is not an error — that is a first visit, and it yields
 * the empty plan with no diagnostic. Everything else that is not a plan is.
 */
export function decodePlanFromHash(hash: string): DecodedHash {
  const withoutHash = hash.startsWith("#") ? hash.slice(1) : hash;
  if (withoutHash === "") return CLEAN;

  const encoded = new URLSearchParams(withoutHash).get(PARAMETER);
  if (encoded === null) return CLEAN;
  if (encoded === "") return unusable("the shared link carries an empty plan");

  const json = fromBase64Url(encoded);
  if (json === null)
    return unusable("the shared link is not readable and has been discarded");

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return unusable("the shared link does not contain a plan and has been discarded");
  }

  /*
   * The same gate a typed-in plan goes through. Not a hash-specific parser:
   * two validators drift, and the one applied to untrusted input is the one
   * that would drift into being weaker.
   */
  const result = validatePlan(parsed);
  if (!result.ok) {
    return unusable(
      `the shared link could not be applied (${result.reason}) and has been discarded`,
    );
  }

  return { plan: result.plan, diagnostic: null };
}
