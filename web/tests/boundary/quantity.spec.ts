import { expect, test } from "@playwright/test";

import {
  asQuantity,
  formatQuantity,
  isIntegral,
  isQuantity,
  partsOf,
  unformatQuantity,
  type Quantity,
} from "../../src/boundary/quantity";

/*
 * Governing: SPEC-0005 REQ "The View Computes No Domain Values", SPEC-0002
 * REQ "Exact Quantity Encoding"
 *
 * "WHEN the boundary reports a quantity as an exact rational that is not an
 * integer THEN the view displays the exact value, and does not round,
 * truncate, or convert it through a floating-point number."
 */

const quantity = (text: string): Quantity => {
  const value = asQuantity(text);
  if (value === null) throw new Error(`${text} should have been accepted`);
  return value;
};

test("a rational survives unchanged", () => {
  expect(formatQuantity(quantity("3/2"))).toBe("3/2");
  expect(isIntegral(quantity("3/2"))).toBe(false);
  expect(partsOf(quantity("3/2"))).toEqual({ numerator: "3", denominator: "2" });
});

test("a value beyond double precision survives unchanged", () => {
  /*
   * 2^53 + 1 is the smallest integer a JavaScript number cannot represent:
   * it rounds to 2^53. The second assertion is the one that matters — it
   * shows the value would have been lost, so the first is not a tautology.
   */
  const exact = "9007199254740993";
  expect(formatQuantity(quantity(exact), { groupSeparator: "" })).toBe(exact);
  expect(String(Number(exact))).not.toBe(exact);
});

test("a repeating rational has no decimal form to be tempted by", () => {
  expect(formatQuantity(quantity("1/3"))).toBe("1/3");
});

test("grouping is reversible, which is the only formatting the spec permits", () => {
  const cases = ["1234567", "-1234567", "1234567/1000", "12", "-3/2"];
  for (const text of cases) {
    const value = quantity(text);
    const shown = formatQuantity(value);
    expect(unformatQuantity(shown), `${text} did not round-trip through ${shown}`).toBe(
      text,
    );
  }
});

test("grouping changes no magnitude", () => {
  expect(formatQuantity(quantity("1234567"))).toBe("1,234,567");
  expect(formatQuantity(quantity("-1234567"))).toBe("-1,234,567");
  expect(formatQuantity(quantity("1234567/1000"))).toBe("1,234,567/1,000");
  expect(formatQuantity(quantity("123"))).toBe("123");
});

test("anything that is not an exact quantity is rejected rather than coerced", () => {
  for (const bad of [
    "1.5",
    "1e3",
    "3 / 2",
    "",
    "NaN",
    "Infinity",
    "0x10",
    " 3",
    "3/",
    "/2",
    "3/0",
    "3/00",
  ]) {
    expect(isQuantity(bad), `${JSON.stringify(bad)} was accepted`).toBe(false);
    expect(asQuantity(bad)).toBeNull();
  }
});

test("a number is not a quantity, however integral", () => {
  expect(asQuantity(3)).toBeNull();
  expect(asQuantity(3.5)).toBeNull();
  expect(asQuantity(null)).toBeNull();
  expect(asQuantity(undefined)).toBeNull();
});
