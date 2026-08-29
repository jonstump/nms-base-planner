/*
 * The store's failure modes, as sentinels rather than prose.
 *
 * Governing: ADR-0008 (durable user data), SPEC-0009 REQ "Error Handling
 * Standards"
 *
 * Selectable by identity, never by message text. The boundary client
 * already enforces this discipline and `tests/boundary/discipline.spec.ts`
 * checks it mechanically; the same rule applies here for the same reason —
 * a message is diagnostic text with no contractual format, and branching on
 * it makes the next wording change a behaviour change.
 */

export const STORE_CODES = [
  /** The stored schemaVersion is one this build does not understand. */
  "UNSUPPORTED_VERSION",
  /** The write would exceed the per-place bound, or the origin's quota. */
  "QUOTA_EXCEEDED",
  /** A single place would exceed the configured bound. Refused before writing. */
  "PLACE_TOO_LARGE",
  /** IndexedDB is absent or blocked — a private window, or a disabled API. */
  "STORAGE_UNAVAILABLE",
  /** The place asked for is not in the store. */
  "RECORD_NOT_FOUND",
  /** A stored record does not match the schema this build reads. */
  "MALFORMED_RECORD",
  /** Anything the classifier could not place. */
  "UNCLASSIFIED",
] as const;

export type StoreCode = (typeof STORE_CODES)[number];

export interface StoreFailure {
  readonly kind: "failed";
  readonly code: StoreCode;
  /** Diagnostic only. Never branched on — see SPEC-0009 REQ "Error Handling Standards". */
  readonly message: string;
}

export type StoreResult<T> = { readonly kind: "ok"; readonly value: T } | StoreFailure;

export function failure(code: StoreCode, message: string): StoreFailure {
  return { kind: "failed", code, message };
}

export function ok<T>(value: T): StoreResult<T> {
  return { kind: "ok", value };
}

/**
 * Map a thrown value onto a sentinel.
 *
 * A pure function so the mapping is testable without provoking the
 * condition. Filling a real disk to observe a quota failure is not a test
 * anyone will run twice, and the interesting question — does a
 * QuotaExceededError reach the caller as the quota sentinel rather than as
 * UNCLASSIFIED — is answerable here.
 */
export function classify(error: unknown, context: string): StoreFailure {
  const name = error instanceof DOMException ? error.name : "";
  const detail = error instanceof Error ? error.message : String(error);
  const message = `${context}: ${detail}`;

  switch (name) {
    case "QuotaExceededError":
      return failure("QUOTA_EXCEEDED", message);
    case "InvalidStateError":
    case "SecurityError":
    case "UnknownError":
      /*
       * A private window with storage blocked, or an origin the browser
       * refuses to persist for. Distinct from a quota failure: there is no
       * amount of freeing up that helps.
       */
      return failure("STORAGE_UNAVAILABLE", message);
    case "NotFoundError":
      return failure("RECORD_NOT_FOUND", message);
    default:
      return failure("UNCLASSIFIED", message);
  }
}
