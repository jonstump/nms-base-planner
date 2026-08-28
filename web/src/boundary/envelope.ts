/*
 * Decoding one envelope.
 *
 * Governing: ADR-0004 (React view layer), SPEC-0005 REQ "Boundary Client",
 * SPEC-0002 REQ "Result Envelope", REQ "Contract Versioning"
 *
 * Every entry point returns the same four-key shape, and this is the only
 * place that reads it. The order below is the requirement's order and it
 * matters: the version is checked before anything looks at `data`, because
 * "the view reports the mismatch naming both versions and does not consume
 * the payload" is a promise about what was *not* read.
 */

import {
  EXPECTED_CONTRACT_VERSION,
  isModuleErrorCode,
  type FailureCode,
  type ModuleErrorCode,
} from "./contract";

/** The envelope as it arrives, before anything is trusted about it. */
interface RawEnvelope {
  ok?: unknown;
  contractVersion?: unknown;
  data?: unknown;
  error?: { code?: unknown; message?: unknown };
}

export type Outcome<T> =
  | { readonly kind: "ok"; readonly value: T }
  | {
      readonly kind: "failed";
      readonly code: FailureCode;
      /** Diagnostic text. Never branched on — see SPEC-0005 REQ "Boundary Client". */
      readonly message: string;
    }
  | {
      readonly kind: "version-mismatch";
      readonly expected: string;
      readonly received: string;
      readonly message: string;
    };

export function failure(code: FailureCode, message: string): Outcome<never> {
  return { kind: "failed", code, message };
}

function malformed(detail: string): Outcome<never> {
  return failure(
    "MALFORMED_ENVELOPE",
    `the module returned something this view cannot read: ${detail}`,
  );
}

/**
 * Parse and validate one envelope.
 *
 * `select` runs only after the version check and the ok/error checks have
 * passed, so there is no path on which a payload from an unknown contract
 * reaches the caller.
 */
export function decodeEnvelope<T>(
  text: string,
  select: (data: unknown) => T | null,
): Outcome<T> {
  let raw: RawEnvelope;
  try {
    raw = JSON.parse(text) as RawEnvelope;
  } catch {
    return malformed("it is not JSON");
  }

  if (typeof raw !== "object" || raw === null) return malformed("it is not an object");

  const received = raw.contractVersion;
  if (typeof received !== "string" || received === "") {
    return malformed("it carries no contractVersion");
  }

  /*
   * Before ok, before error, before data. A mismatched contract makes every
   * other field's meaning a guess, including which of ok and error is
   * authoritative.
   */
  if (received !== EXPECTED_CONTRACT_VERSION) {
    return {
      kind: "version-mismatch",
      expected: EXPECTED_CONTRACT_VERSION,
      received,
      message:
        `the module implements boundary contract ${received}, ` +
        `and this view was built for ${EXPECTED_CONTRACT_VERSION}`,
    };
  }

  if (raw.ok !== true) {
    const code: unknown = raw.error?.code;
    const message: unknown = raw.error?.message;
    return failure(
      isModuleErrorCode(code) ? code : "UNCLASSIFIED",
      typeof message === "string"
        ? message
        : "the module reported a failure with no message",
    );
  }

  const value = select(raw.data);
  if (value === null)
    return malformed("the result payload is not the shape this call expects");
  return { kind: "ok", value };
}

/** True when a failure is the module saying "not yet", rather than "no". */
export function isNotReady(outcome: Outcome<unknown>): boolean {
  return (
    outcome.kind === "failed" && outcome.code === ("NOT_READY" satisfies ModuleErrorCode)
  );
}
