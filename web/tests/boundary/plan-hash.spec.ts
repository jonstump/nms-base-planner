import { expect, test } from "@playwright/test";

import {
  EMPTY_PLAN,
  isEmptyPlan,
  validatePlan,
  type Plan,
} from "../../src/boundary/plan";
import { decodePlanFromHash, encodePlanToHash } from "../../src/boundary/plan-hash";
import { asQuantity, type Quantity } from "../../src/boundary/quantity";

/*
 * Governing: ADR-0002 (plan state in the URL hash), SPEC-0005 Security
 * Requirements → Redirect Validation, REQ "Boundary Client"
 *
 * "An undecodable URL hash yields an empty plan and a diagnostic, never a
 * partial one."
 *
 * Anyone can hand a user a link, so every case below is an attacker's input
 * as much as a corrupted one.
 */

const q = (text: string): Quantity => {
  const value = asQuantity(text);
  if (value === null) throw new Error(`${text} is not a quantity`);
  return value;
};

const PLAN: Plan = {
  target: "STASIS_DEVICE",
  quantity: q("3"),
  methods: { CAVE2: "REFINE" },
  recipes: { OXYGEN: "OXYGEN_REFINE" },
};

function hashOf(value: unknown): string {
  const json = JSON.stringify(value);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64url = btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `#p=${base64url}`;
}

test("a plan round-trips through the hash", () => {
  const decoded = decodePlanFromHash(encodePlanToHash(PLAN));
  expect(decoded.diagnostic).toBeNull();
  expect(decoded.plan).toEqual(PLAN);
});

test("a first visit is not an error", () => {
  for (const hash of ["", "#", "#other=1"]) {
    const decoded = decodePlanFromHash(hash);
    expect(
      decoded.diagnostic,
      `${JSON.stringify(hash)} produced a diagnostic`,
    ).toBeNull();
    expect(isEmptyPlan(decoded.plan)).toBe(true);
  }
});

test("an unreadable hash yields the empty plan and a diagnostic", () => {
  for (const hash of ["#p=", "#p=!!!!", "#p=notbase64$$", "#p=YWJj"]) {
    const decoded = decodePlanFromHash(hash);
    expect(decoded.diagnostic, `${hash} produced no diagnostic`).not.toBeNull();
    expect(decoded.plan).toEqual(EMPTY_PLAN);
  }
});

test("a hash that is valid base64 but not a plan yields the empty plan", () => {
  for (const value of [42, "a string", [1, 2, 3], null, { nothing: true }]) {
    const decoded = decodePlanFromHash(hashOf(value));
    expect(
      decoded.diagnostic,
      `${JSON.stringify(value)} produced no diagnostic`,
    ).not.toBeNull();
    expect(decoded.plan).toEqual(EMPTY_PLAN);
  }
});

test("a partly-valid plan yields the empty plan, never the valid part", () => {
  /*
   * The criterion the code is shaped around. Each of these carries a
   * perfectly good target, and keeping it would put a user in front of a
   * plan that is neither the one in their link nor the one they had.
   */
  const partial = [
    { target: "STASIS_DEVICE", quantity: "1.5" },
    { target: "STASIS_DEVICE", quantity: "-3" },
    { target: "STASIS_DEVICE", quantity: 3 },
    { target: "STASIS_DEVICE" },
    { target: "STASIS_DEVICE", quantity: "3", methods: "not an object" },
    { target: "STASIS_DEVICE", quantity: "3", methods: { CAVE2: 7 } },
    { target: "STASIS_DEVICE", quantity: "3", recipes: { "bad key!": "X" } },
  ];

  for (const value of partial) {
    const decoded = decodePlanFromHash(hashOf(value));
    expect(decoded.plan, `${JSON.stringify(value)} was partly applied`).toEqual(
      EMPTY_PLAN,
    );
    expect(decoded.plan.target).toBe("");
    expect(decoded.diagnostic).not.toBeNull();
  }
});

test("a hash carrying a URL in a plan field is rejected outright", () => {
  /*
   * SPEC-0005: "The application MUST NOT navigate to a URL taken from
   * decoded state." Nothing in the boundary can navigate — checked in
   * discipline.spec.ts — and this is the second layer: a value shaped like a
   * URL is not a usable identifier, so it never becomes plan state at all.
   */
  const hostile = [
    { target: "javascript:alert(1)", quantity: "1" },
    { target: "https://example.invalid/steal", quantity: "1" },
    { target: "//example.invalid", quantity: "1" },
    { target: "STASIS_DEVICE", quantity: "1", methods: { CAVE2: "javascript:alert(1)" } },
  ];

  for (const value of hostile) {
    const decoded = decodePlanFromHash(hashOf(value));
    expect(decoded.plan, `${JSON.stringify(value)} was accepted`).toEqual(EMPTY_PLAN);
    expect(decoded.diagnostic).not.toBeNull();
  }
});

test("an overlong identifier is rejected", () => {
  const decoded = decodePlanFromHash(hashOf({ target: "A".repeat(65), quantity: "1" }));
  expect(decoded.plan).toEqual(EMPTY_PLAN);
});

test("`reason` is a usable override key", () => {
  /*
   * Regression. The override validator once returned either a plain object or
   * `{reason}`, and `reason` is a legal key — so `methods: {reason: "SMELT"}`
   * was read as a rejection carrying the reason "SMELT", discarding a valid
   * plan and reporting nonsense. Untrusted input decides the key set, so the
   * discriminant cannot live inside it.
   */
  const result = validatePlan({
    target: "STASIS_DEVICE",
    quantity: "1",
    methods: { reason: "SMELT" },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.plan.methods).toEqual({ reason: "SMELT" });
});

test("the hash decoder and a typed-in plan go through the same gate", () => {
  /*
   * Not "both reject the same values" by coincidence — the criterion is that
   * there is one path. If decodePlanFromHash grew a private validator, this
   * pair would drift apart on the first case neither author thought about.
   */
  const cases: unknown[] = [
    { target: "STASIS_DEVICE", quantity: "3" },
    { target: "STASIS_DEVICE", quantity: "1.5" },
    { target: "", quantity: "1" },
    { target: "javascript:alert(1)", quantity: "1" },
    { target: "STASIS_DEVICE", quantity: "3", methods: { A: "B" } },
  ];

  for (const value of cases) {
    const direct = validatePlan(value);
    const viaHash = decodePlanFromHash(hashOf(value));
    expect(viaHash.diagnostic === null, `${JSON.stringify(value)} disagreed`).toBe(
      direct.ok,
    );
    if (direct.ok) expect(viaHash.plan).toEqual(direct.plan);
  }
});
