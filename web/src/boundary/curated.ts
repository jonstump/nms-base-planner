/*
 * Fetching the Tier 2 curated constants and proving they are what the
 * engine will accept.
 *
 * Governing: ADR-0001 (two-tier ingestion — Tier 2 is hand-maintained),
 * ADR-0004 (React view layer), SPEC-0005 REQ "Module Loading", SPEC-0002
 * REQ "Exact Quantity Encoding", SPEC-0001 REQ "Provenance Propagation"
 *
 * Tier 1 is validated by the module: it is generated, the module loads it,
 * and INVALID_ARTIFACT is the module's own opinion. Tier 2 is not like
 * that. It is a file a person edits, the module never sees it — it crosses
 * on each request instead — and the engine's answer to a bad one is
 * MISSING_CONSTANT on the first rollup, which names the constant but not
 * the typo. So it is checked here, at the point the file is read, where the
 * failure can say which field and why.
 *
 * Nothing here runs at import time, for the same reason nothing in
 * module.ts does: the shell decides when to pay for this.
 *
 * The file's shape is not `Curated`. It carries a `source` and a `verified`
 * date per entry — ADR-0001 requires that, and it is the whole reason the
 * unverified badge can ever be switched off — and the engine wants seven
 * scalars and a date map. Translating between the two is this module's job
 * and the reason it is worth having.
 */

import type { Curated } from "./requests";
import { failure, type Outcome } from "./envelope";
import { asQuantity, isIntegral, partsOf, type Quantity } from "./quantity";

/** Where scripts/build-wasm.sh installs the curated set. */
export const DEFAULT_CURATED_PATH = "/tier2.json";

/** The fields of `Curated` that are required scalars, not optional maps. */
type ScalarField = Exclude<
  keyof Curated,
  "faunaProducts" | "resourceHotspots" | "verifiedOn"
>;

/**
 * The seven scalars, each paired with the name the engine keys its
 * verification dates by.
 *
 * Both spellings in one table, because they are two names for one thing and
 * a file that supplied `biodomeCropSlots` while verifying it under some
 * other spelling would be verified in a way nothing reads. The domain keeps
 * the same table for the same reason — see the `Constant*` block in
 * internal/domain/rollup.go.
 *
 * Typed as a complete mapping rather than a list, which is what makes the
 * single assertion at the end of `parseCurated` honest: a scalar added to
 * `Curated` and not added here fails to compile, so the loop below cannot
 * silently stop covering the type it builds.
 */
const SCALARS: { readonly [K in ScalarField]: string } = {
  biodomeCropSlots: "biodome crop slots",
  faunaYieldPerCycle: "fauna yield per cycle",
  faunaCycleSeconds: "fauna cycle seconds",
  stepsPerProcessor: "steps per processor",
  depotThreshold: "depot threshold",
  processSeconds: "process seconds",
  panelsPerBattery: "panels per battery",
};

interface RawEntry {
  value?: unknown;
  verified?: unknown;
}

interface RawFile {
  constants?: Record<string, RawEntry | undefined>;
  faunaProducts?: { items?: unknown };
  resourceHotspots?: { categories?: unknown };
}

function invalid(detail: string): Outcome<never> {
  return failure(
    "CONSTANTS_INVALID",
    `the curated constants could not be read: ${detail}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A whole count greater than zero, or null.
 *
 * The engine refuses a constant that is zero or negative — `validate` in
 * internal/domain/rollup.go raises MISSING_CONSTANT for it — and every one
 * of the seven is a count or a whole number of seconds, so a fraction is a
 * bad edit rather than an exact value worth carrying.
 *
 * The sign and zero tests are string inspection, not arithmetic. SPEC-0005
 * forbids the view converting a quantity to a number, and there is nothing
 * here to convert: a leading `-` and the absence of any nonzero digit are
 * both visible in the decimal string.
 */
function positiveWhole(value: unknown): Quantity | null {
  const quantity = asQuantity(value);
  if (quantity === null || !isIntegral(quantity)) return null;
  const { numerator } = partsOf(quantity);
  if (numerator.startsWith("-")) return null;
  return /[1-9]/.test(numerator) ? quantity : null;
}

/*
 * The two classification maps, read whole or not at all.
 *
 * Filtered and then length-checked rather than asserted: one non-string in
 * the list is a malformed file, and silently dropping it would leave an
 * item classified as neither fauna nor a hotspot resource — which reads
 * downstream as a deliberate omission rather than as the typo it is.
 */
function stringList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.filter((item): item is string => typeof item === "string");
  return items.length === value.length ? items : null;
}

function stringMap(value: unknown): Readonly<Record<string, string>> | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  const strings = entries.filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return strings.length === entries.length ? Object.fromEntries(strings) : null;
}

/**
 * Turn the file into the set the engine takes, or say what is wrong with it.
 *
 * Exported separately from the fetch so the shape can be tested without a
 * server, and so a caller that already has the text — a test fixture, a
 * future import path — does not have to go through the network to use it.
 */
export function parseCurated(text: string): Outcome<Curated> {
  let raw: RawFile;
  try {
    raw = JSON.parse(text) as RawFile;
  } catch {
    return invalid("it is not JSON");
  }

  if (!isRecord(raw)) return invalid("it is not an object");

  const constants = raw.constants;
  if (!isRecord(constants)) return invalid("it carries no `constants` object");

  const curated: Record<string, unknown> = {};
  const verifiedOn: Record<string, string> = {};

  for (const [field, name] of Object.entries(SCALARS)) {
    const entry: unknown = constants[field];
    if (!isRecord(entry)) return invalid(`\`constants.${field}\` is missing`);

    const quantity = positiveWhole(entry.value);
    if (quantity === null) {
      return invalid(
        `\`constants.${field}.value\` must be a whole count above zero as a decimal string`,
      );
    }
    curated[field] = quantity;

    /*
     * Absence is the meaningful case, and null is how this file spells it.
     * A constant with no date is read as unverified and taints every figure
     * derived from it, so the map is built from what is present rather than
     * defaulted to today — which would silently assert that everything here
     * had been confirmed in game.
     */
    const verified: unknown = entry.verified;
    if (typeof verified === "string" && verified !== "") verifiedOn[name] = verified;
    else if (verified !== null && verified !== undefined) {
      return invalid(`\`constants.${field}.verified\` must be a date string or null`);
    }
  }

  if (raw.faunaProducts !== undefined) {
    if (!isRecord(raw.faunaProducts)) return invalid("`faunaProducts` is not an object");
    const items = stringList(raw.faunaProducts.items);
    if (items === null) return invalid("`faunaProducts.items` is not a list of item ids");
    if (items.length > 0) curated.faunaProducts = items;
  }

  if (raw.resourceHotspots !== undefined) {
    if (!isRecord(raw.resourceHotspots))
      return invalid("`resourceHotspots` is not an object");
    const categories = stringMap(raw.resourceHotspots.categories);
    if (categories === null)
      return invalid("`resourceHotspots.categories` is not a map of item id to category");
    if (Object.keys(categories).length > 0) curated.resourceHotspots = categories;
  }

  if (Object.keys(verifiedOn).length > 0) curated.verifiedOn = verifiedOn;

  /*
   * The one assertion in this module, and the only place it could be. Every
   * required field was just written from `SCALARS`, which is typed as a
   * complete mapping of `Curated`'s scalar fields — so the compiler already
   * refuses a table that has stopped covering the type, and what is left
   * for the cast to say is only that the loop ran over all of it.
   */
  return { kind: "ok", value: curated as unknown as Curated };
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Fetch and validate the curated set.
 *
 * The two failures are kept apart the way the module keeps its two apart: a
 * file that did not arrive is a deployment or network problem, and a file
 * that arrived and does not check out is an editing problem. They call for
 * different answers and the shell should not have to guess which it has.
 */
export async function fetchCurated(
  path: string = DEFAULT_CURATED_PATH,
): Promise<Outcome<Curated>> {
  let text: string;
  try {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`responded ${String(response.status)}`);
    text = await response.text();
  } catch (cause) {
    return failure(
      "CONSTANTS_FETCH_FAILED",
      `${path} could not be fetched: ${describe(cause)}`,
    );
  }
  return parseCurated(text);
}
