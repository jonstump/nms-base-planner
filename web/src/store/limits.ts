/*
 * The per-place size bound.
 *
 * Governing: ADR-0008 (durable user data), SPEC-0009 § Security
 * Requirements → Request Body Size Limits
 *
 * SPEC-0005 recorded this value as unchosen and SPEC-0009 requires it be
 * "derived from measurement rather than guessed" and "recorded with the
 * sizes it was derived from". Here are the sizes.
 *
 * Measured against the 108-entry parts catalog in `data/tier1.json`, with
 * realistic natural-language notes rather than compressible filler — the
 * distinction that mattered when ADR-0008 measured the URL-hash case and a
 * first pass using `"x" * 400` reported figures four times too small:
 *
 *   ticks  stocked  tags   JSON bytes
 *      40       20     4        1,677   typical, part-way through a build
 *     108       20     4        2,966   every catalogue part ticked
 *     108      200    20        6,156   heavy: long tag list, deep stock
 *
 * So a text place tops out near 6 KB. The bound is 64 KiB — an order of
 * magnitude above the heavy case, which leaves room for fields this schema
 * does not have yet while still refusing something pathological: a document
 * pasted into a note, or a data URL somebody tried to smuggle in as text.
 *
 * Images are NOT in scope. ADR-0008 defers blob storage to a later ADR on
 * measured grounds — one capture is 1.5–3 MB against 596 KB for a 200-place
 * text workspace — so this bound is a text bound, and a store that starts
 * holding images needs it revisited rather than inherited.
 */

/** 64 KiB. See the measurements above. */
export const MAX_PLACE_BYTES = 64 * 1024;

/** The measurements the bound was set from, so a future change can argue with them. */
export const MEASURED_PLACE_BYTES = Object.freeze({
  typical: 1_677,
  everyPartTicked: 2_966,
  heavy: 6_156,
});

/**
 * The serialized size of a value, in bytes.
 *
 * UTF-8 rather than string length: a note in a language outside Latin-1
 * costs more bytes than characters, and the quota is counted in bytes.
 */
export function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}
