import { expect, test } from "@playwright/test";

import { EXPECTED_CONTRACT_VERSION } from "../../src/boundary/contract";
import { decodeEnvelope, isNotReady } from "../../src/boundary/envelope";

/*
 * Governing: SPEC-0005 REQ "Boundary Client", SPEC-0002 REQ "Result
 * Envelope", REQ "Contract Versioning"
 */

const VERSION = EXPECTED_CONTRACT_VERSION;

/** `select` is the only thing that reads `data`, so this proves nothing did. */
function refuseToRead(): never {
  throw new Error("the payload was consumed");
}

const accept = (data: unknown): unknown => data ?? null;

test("a mismatched contract version is reported naming both versions", () => {
  const outcome = decodeEnvelope(
    JSON.stringify({ ok: true, contractVersion: "9.9.9", data: { graph: {} } }),
    refuseToRead,
  );

  expect(outcome.kind).toBe("version-mismatch");
  if (outcome.kind !== "version-mismatch") return;
  expect(outcome.received).toBe("9.9.9");
  expect(outcome.expected).toBe(VERSION);
  expect(outcome.message).toContain("9.9.9");
  expect(outcome.message).toContain(VERSION);
});

test("a mismatched contract version consumes no payload", () => {
  /*
   * `refuseToRead` throws. If the decoder reached the payload at all — even
   * to check its shape before reporting the mismatch — this test errors
   * rather than fails, which is the difference between "did not use it" and
   * "did not look at it".
   */
  expect(() =>
    decodeEnvelope(
      JSON.stringify({
        ok: true,
        contractVersion: "0.1.0",
        data: { graph: { nodes: [] } },
      }),
      refuseToRead,
    ),
  ).not.toThrow();
});

test("a mismatch is reported even when the envelope claims failure", () => {
  /*
   * ok and error mean whatever the other contract said they mean. Reading
   * the error first would report a code from a code set this view does not
   * know, as though it did.
   */
  const outcome = decodeEnvelope(
    JSON.stringify({
      ok: false,
      contractVersion: "0.9.0",
      error: { code: "UNKNOWN_ITEM", message: "x" },
    }),
    accept,
  );
  expect(outcome.kind).toBe("version-mismatch");
});

test("a failure carries a code from the stable set", () => {
  const outcome = decodeEnvelope(
    JSON.stringify({
      ok: false,
      contractVersion: VERSION,
      error: { code: "CYCLE_DETECTED", message: "A -> B -> A" },
    }),
    accept,
  );

  expect(outcome.kind).toBe("failed");
  if (outcome.kind !== "failed") return;
  expect(outcome.code).toBe("CYCLE_DETECTED");
});

test("an unrecognised code becomes UNCLASSIFIED rather than being trusted", () => {
  const outcome = decodeEnvelope(
    JSON.stringify({
      ok: false,
      contractVersion: VERSION,
      error: { code: "SOMETHING_NEW", message: "x" },
    }),
    accept,
  );
  expect(outcome.kind).toBe("failed");
  if (outcome.kind !== "failed") return;
  expect(outcome.code).toBe("UNCLASSIFIED");
});

test("NOT_READY is distinguishable from a call that failed", () => {
  const notReady = decodeEnvelope(
    JSON.stringify({
      ok: false,
      contractVersion: VERSION,
      error: { code: "NOT_READY", message: "x" },
    }),
    accept,
  );
  const failed = decodeEnvelope(
    JSON.stringify({
      ok: false,
      contractVersion: VERSION,
      error: { code: "UNKNOWN_ITEM", message: "x" },
    }),
    accept,
  );

  expect(isNotReady(notReady)).toBe(true);
  expect(isNotReady(failed)).toBe(false);
});

test("a failure envelope carries no payload to consume", () => {
  expect(() =>
    decodeEnvelope(
      JSON.stringify({
        ok: false,
        contractVersion: VERSION,
        error: { code: "UNKNOWN_ITEM", message: "x" },
      }),
      refuseToRead,
    ),
  ).not.toThrow();
});

test("anything that is not an envelope is a failure, not a crash", () => {
  for (const bad of [
    "",
    "not json",
    "[]",
    "null",
    '{"ok":true}',
    '{"ok":true,"contractVersion":""}',
  ]) {
    const outcome = decodeEnvelope(bad, accept);
    expect(outcome.kind, `${JSON.stringify(bad)} was accepted`).toBe("failed");
    if (outcome.kind !== "failed") continue;
    expect(outcome.code).toBe("MALFORMED_ENVELOPE");
  }
});

test("a success whose payload is the wrong shape is a failure, not a partial result", () => {
  const outcome = decodeEnvelope(
    JSON.stringify({
      ok: true,
      contractVersion: VERSION,
      data: { graph: "not an object" },
    }),
    () => null,
  );
  expect(outcome.kind).toBe("failed");
});
