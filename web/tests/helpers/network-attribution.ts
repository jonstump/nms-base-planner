/*
 * Attributing a network attempt to the code that made it.
 *
 * Governing: SPEC-0009 REQ "Stage 1 Reaches No Network"
 *
 * The requirement's second scenario is the awkward one: "WHEN the
 * application also contains code that makes network requests for unrelated
 * reasons THEN the assertion still holds". A recorder that counts every
 * request the page makes cannot satisfy that — it goes red the day anything
 * else on the page fetches something, and the fix would be to loosen it
 * until it stopped complaining.
 *
 * So each recorded attempt carries the stack it was made from, and the
 * question asked of it is "did this come from a store path", not "did this
 * happen". That is the difference the acceptance criterion is drawing when
 * it says the check must assert on "this capability's own call paths rather
 * than on the absence of network code in the application bundle".
 *
 * A limit worth stating plainly: a synchronous frame is always visible, but
 * a continuation resumed after `await` depends on the engine's async stack
 * tagging, which is present in Chromium and is not guaranteed everywhere.
 * The suite does not rest on this alone — `tests/store/discipline.spec.ts`
 * also asserts that a quiet page running only store operations records no
 * attempt of any kind, which needs no stack at all. Attribution is what
 * lets that assertion survive the arrival of stage 2's network code
 * instead of being weakened to accommodate it.
 */

export interface NetworkAttempt {
  /** Which primitive was reached for: fetch, xhr, beacon, websocket, eventsource. */
  readonly kind: string;
  /** The stack captured at the call, header line included. */
  readonly stack: string;
}

/**
 * Does any frame of this stack sit inside `fragment`?
 *
 * The header line is dropped before matching. `new Error().stack` opens
 * with "Error" and, were a message ever added, matching it would attribute
 * a request to whatever the message happened to mention.
 */
export function attributedTo(stack: string, fragment: string): boolean {
  return stack
    .split("\n")
    .slice(1)
    .some((frame) => frame.includes(fragment));
}

/** Attempts whose stack reaches into `fragment`. */
export function attemptsFrom(
  attempts: readonly NetworkAttempt[],
  fragment: string,
): NetworkAttempt[] {
  return attempts.filter((attempt) => attributedTo(attempt.stack, fragment));
}
