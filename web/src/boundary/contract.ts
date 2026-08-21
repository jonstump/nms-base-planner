/*
 * The boundary contract, restated on the view's side.
 *
 * Governing: ADR-0004 (React view layer), SPEC-0005 REQ "Boundary Client",
 * SPEC-0002 REQ "Result Envelope", REQ "Contract Versioning"
 *
 * Every name here mirrors one in internal/bridge. The duplication is the
 * point: SPEC-0002 REQ "Contract Versioning" requires the view to check the
 * module's version against the version it was built for, and a view that
 * imported its expectations from the module could not disagree with it.
 */

/**
 * The contract version this view was written against.
 *
 * Bump only alongside the code that handles the new shape. It is compared
 * with the `contractVersion` on every envelope; a mismatch is reported
 * naming both and no payload is read.
 */
export const EXPECTED_CONTRACT_VERSION = "1.2.0";

/*
 * The stable code set from internal/bridge/errors.go.
 *
 * SPEC-0005 REQ "Boundary Client": the view "MUST branch on the error
 * payload's stable code and MUST NOT parse the human-readable message to
 * determine failure kind". The message carries the domain's resolution path
 * and has no contractual format — it is diagnostic text and nothing else.
 */
export const ERROR_CODES = [
  "UNKNOWN_ITEM",
  "ILLEGAL_METHOD",
  "CYCLE_DETECTED",
  "MISSING_CONSTANT",
  "INVALID_ARTIFACT",
  "NOT_READY",
  "MALFORMED_INPUT",
  "VERSION_MISMATCH",
  "UNCLASSIFIED",
] as const;

export type ModuleErrorCode = (typeof ERROR_CODES)[number];

/*
 * Codes raised on this side of the boundary, for failures that happen before
 * the module can answer — a network error, a bad MIME type, a shim that never
 * defined globalThis.Go.
 *
 * SPEC-0005 REQ "Module Loading": "A module that fails to load MUST be
 * reported distinctly from an artifact that fails to validate." The artifact
 * case comes back as the module's own INVALID_ARTIFACT, because by then the
 * module is running and has an opinion. These are the cases where it is not.
 */
export const CLIENT_CODES = [
  "MODULE_LOAD_FAILED",
  "ARTIFACT_FETCH_FAILED",
  "MALFORMED_ENVELOPE",
] as const;

export type ClientErrorCode = (typeof CLIENT_CODES)[number];

export type FailureCode = ModuleErrorCode | ClientErrorCode;

export function isModuleErrorCode(value: unknown): value is ModuleErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}

/** The single global the module registers under (bridge.Namespace). */
export const NAMESPACE = "nmsPlanner";

/** Entry point names (bridge.EntryPoints). Each takes and returns a string. */
export const ENTRY_POINTS = ["load", "ready", "resolve", "rollup", "power"] as const;

export type EntryPoint = (typeof ENTRY_POINTS)[number];

/**
 * The module's shape as seen from JavaScript.
 *
 * Every entry point is `(string) => string`: the argument and the envelope
 * both cross as JSON text. Nothing structured crosses, which is what keeps a
 * quantity from becoming a JavaScript number on the way.
 */
export interface PlannerModule {
  readonly contractVersion: string;
  load(artifactJSON: string): string;
  ready(argument: string): string;
  resolve(planJSON: string): string;
  rollup(requestJSON: string): string;
  power(requestJSON: string): string;
}
