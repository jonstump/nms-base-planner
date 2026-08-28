/*
 * Exact quantities, which is to say: strings, all the way through.
 *
 * Governing: ADR-0004 (React view layer), SPEC-0005 REQ "The View Computes
 * No Domain Values", SPEC-0002 REQ "Exact Quantity Encoding"
 *
 * The engine computes in big.Rat and encodes as "a/b" or "a". Both are exact.
 * A JavaScript number is not: it cannot hold 2^53 + 1, and it cannot hold 3/2
 * — well, it can hold 3/2, but it cannot hold 1/3, and the boundary carries
 * whichever the recipe produced. The requirement is that the view "MUST NOT
 * perform arithmetic on quantities ... including rounding", and the only way
 * to keep that promise is never to convert.
 *
 * So there is no parse step here. Nothing in this module produces a number,
 * and tests/boundary/no-arithmetic.spec.ts fails the build if one appears.
 */

/**
 * A quantity as the boundary encodes it: `"300"`, `"3/2"`, `"-5"`.
 *
 * Branded so a bare string cannot be passed where an exact value is meant,
 * and so a value that has been through a number cannot be laundered back in.
 */
export type Quantity = string & { readonly __quantity: unique symbol };

/** `a`, `-a`, `a/b` — decimal digits only, no exponent and no decimal point. */
const EXACT = /^-?\d+(?:\/\d+)?$/;

export function isQuantity(value: unknown): value is Quantity {
  return typeof value === "string" && EXACT.test(value) && !/\/0+$/.test(value);
}

/**
 * Accept a boundary-supplied string as a quantity.
 *
 * Rejects rather than coerces. A malformed quantity means the envelope did
 * not come from a contract this view understands, and guessing at it would
 * put a wrong figure in front of a user with no way to tell.
 */
export function asQuantity(value: unknown): Quantity | null {
  return isQuantity(value) ? value : null;
}

export interface QuantityParts {
  /** May carry a leading `-`. */
  readonly numerator: string;
  /** `"1"` for an integral quantity. */
  readonly denominator: string;
}

/** Split without arithmetic: both halves stay decimal strings. */
export function partsOf(quantity: Quantity): QuantityParts {
  const slash = quantity.indexOf("/");
  if (slash === -1) return { numerator: quantity, denominator: "1" };
  return { numerator: quantity.slice(0, slash), denominator: quantity.slice(slash + 1) };
}

export function isIntegral(quantity: Quantity): boolean {
  return partsOf(quantity).denominator === "1";
}

/** Group an unsigned digit run into threes, right to left. */
function group(digits: string, separator: string): string {
  let out = "";
  for (let i = 0; i < digits.length; i += 1) {
    const fromEnd = digits.length - i;
    if (i > 0 && fromEnd % 3 === 0) out += separator;
    out += digits[i];
  }
  return out;
}

export interface FormatOptions {
  /** Thousands separator. Empty string leaves the digits untouched. */
  readonly groupSeparator?: string;
}

/**
 * Render a quantity for display.
 *
 * SPEC-0005 permits formatting "only where the formatting is reversible to
 * the value received and changes no magnitude". Digit grouping qualifies:
 * removing the separators recovers the original string exactly, which
 * {@link unformatQuantity} does and the tests check both ways.
 *
 * A non-integral quantity keeps its `a/b` form. There is no decimal
 * rendering, because producing one means choosing a precision, and any
 * precision truncates some value the engine computed exactly — 1/3 has no
 * decimal form at all. A user seeing `3/2` is seeing the number the engine
 * produced; a user seeing `1.50` is seeing a claim about it.
 */
export function formatQuantity(quantity: Quantity, options: FormatOptions = {}): string {
  const separator = options.groupSeparator ?? ",";
  if (separator === "") return quantity;

  const { numerator, denominator } = partsOf(quantity);
  const negative = numerator.startsWith("-");
  const digits = negative ? numerator.slice(1) : numerator;
  const head = (negative ? "-" : "") + group(digits, separator);

  return denominator === "1" ? head : `${head}/${group(denominator, separator)}`;
}

/** The inverse of {@link formatQuantity}, which is what makes it reversible. */
export function unformatQuantity(
  formatted: string,
  options: FormatOptions = {},
): Quantity | null {
  const separator = options.groupSeparator ?? ",";
  const stripped = separator === "" ? formatted : formatted.split(separator).join("");
  return asQuantity(stripped);
}
