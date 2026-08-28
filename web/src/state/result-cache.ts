/*
 * The boundary-result cache: one entry, keyed by the inputs that produced it.
 *
 * Governing: ADR-0004 (React view layer), SPEC-0005 REQ "View State
 * Boundaries"
 *
 * "Where a boundary result is cached, the cache MUST be invalidated by the
 * inputs that produced it and MUST NOT be edited in place."
 *
 * Both halves are structural rather than agreed.
 *
 * Invalidation: there is exactly one slot. Writing under a new key replaces
 * the old entry, so a stale result cannot survive an input change — there is
 * nowhere for it to survive. A Map keyed by input would have kept it, and
 * "which of these three graphs is current" is the question that produces a
 * screen showing figures from two different plans at once.
 *
 * In-place editing: stored values are deep-frozen. A component that tried to
 * adjust a total rather than re-cross would throw, in development and in
 * production, rather than silently producing a figure the domain never
 * computed.
 */

/** Freeze an object graph. Cycles are not possible in a decoded envelope. */
function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const entry of Object.values(value as Record<string, unknown>)) {
    deepFreeze(entry);
  }
  return Object.freeze(value);
}

export class ResultCache<T> {
  #key: string | null = null;
  #value: T | null = null;

  /** The cached value for `key`, or null if the inputs have moved on. */
  read(key: string): T | null {
    return this.#key === key ? this.#value : null;
  }

  /**
   * Store a result under the inputs that produced it.
   *
   * Replaces whatever was there. There is no merge and no update-in-place
   * path, because a boundary result is only ever the whole answer to one
   * question.
   */
  write(key: string, value: T): T {
    const frozen = deepFreeze(value);
    this.#key = key;
    this.#value = frozen;
    return frozen;
  }

  /** For tests and for a shell that wants to show "recomputing". */
  currentKey(): string | null {
    return this.#key;
  }

  clear(): void {
    this.#key = null;
    this.#value = null;
  }
}
