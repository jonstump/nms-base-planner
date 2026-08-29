/*
 * Claims the storage does not make.
 *
 * Governing: SPEC-0009 REQ "Storage Is Evictable and the Application Must
 * Not Imply Otherwise", REQ "Screenshots Are Local-Only"
 *
 * Both requirements are about what the interface says, not what it does,
 * and that is unusual enough to be worth stating. There is no technical
 * mitigation at stage 1: browsers evict origin storage under pressure,
 * private windows discard it on close, and until an account exists there is
 * no recovery path. Being accurate about the scope IS the mitigation. So
 * the check is on the words.
 *
 * These are pure functions over text rather than over source, because the
 * requirement is about what reaches the player. A component can hold the
 * string "backed up" in a comment explaining why it must not say that —
 * this file's own regex is the extreme case — and scanning source would
 * make the explanation the offence. The suite runs these over the rendered
 * page's visible text, where a false positive is impossible by
 * construction.
 */

/**
 * Phrases that promise more than local storage can deliver.
 *
 * "Saved" alone is deliberately absent. It is the ordinary word for what
 * happened and banning it would push the interface toward circumlocution,
 * which reads as evasive rather than as honest. What is banned is the
 * claim that the data is somewhere *else* as well, or that it cannot be
 * lost — those are the two things that are false.
 *
 * `cloud` is matched bare rather than as part of a phrase. The first draft
 * matched "in the cloud" and missed "saved to the cloud", which is the same
 * claim with a different preposition — the kind of gap a phrase list always
 * has. The word has no legitimate use in a planner that reaches no network.
 */
const DURABILITY_CLAIM =
  /\b(?:backed[ -]?up|back(?:ing)?[ -]up|backups?|synced?|syncing|synchroni[sz]\w*|cloud|never lose|cannot lose|can't lose|won't lose|safely stored|stored safely|kept safe|permanently stored|stored forever|always available|guaranteed)\b/gi;

/** Every durability claim in a piece of visible text. */
export function durabilityClaims(text: string): string[] {
  return [...text.matchAll(DURABILITY_CLAIM)].map((match) => match[0]);
}

/**
 * Control names whose effect would be to send something off the device.
 *
 * "Export" and "Download" are not matched, and the distinction is real:
 * both hand a file to the player, and neither transmits it anywhere. What
 * is matched is publishing and uploading — the operations ADR-0013 has not
 * been written yet to authorise.
 */
const SHARING_CONTROL =
  /\b(?:share|sharing|upload|uploading|publish|publishing|post to|send to|copy link|share link|invite)\b/i;

/** The subset of these control names that would share or upload. */
export function sharingControls(names: readonly string[]): string[] {
  return names.filter((name) => SHARING_CONTROL.test(name));
}
