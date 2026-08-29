/*
 * Source-level discipline checks for the boundary client.
 *
 * Governing: SPEC-0005 REQ "Boundary Client", REQ "The View Computes No
 * Domain Values", Security Requirements → Redirect Validation
 *
 * Three of this story's acceptance criteria are about what the code does
 * *not* do — no branching on message text, no arithmetic on quantities, no
 * navigation to decoded state. A behavioural test cannot cover an absence:
 * it can only show that the paths it thought to exercise behave, and the
 * failure mode is always the path nobody thought of.
 *
 * Same shape as tests/helpers/css-checks.ts: pure functions over a string,
 * so each is run against the real sources and against a snippet containing
 * exactly the mistake it exists to catch.
 */

export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/** Line comments and block comments, blanked while preserving line numbers. */
const COMMENTS = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

function stripComments(source: string): string {
  return source.replace(COMMENTS, (match) => match.replace(/[^\n]/g, " "));
}

function scan(file: string, source: string, pattern: RegExp): Finding[] {
  const out: Finding[] = [];
  stripComments(source)
    .split("\n")
    .forEach((line, index) => {
      if (pattern.test(line)) out.push({ file, line: index + 1, text: line.trim() });
    });
  return out;
}

/*
 * Reading an error message to decide what happened.
 *
 * SPEC-0005 REQ "Boundary Client": the view "MUST branch on the error
 * payload's stable code and MUST NOT parse the human-readable message to
 * determine failure kind". Constructing a message is fine — every pattern
 * below is an inspection.
 *
 * Two exclusions, both narrow. `typeof message === "string"` is a type guard
 * on an unknown field, not a branch on its content, so the lookbehind drops
 * it. And an equality is only a finding when its right-hand side is a string
 * literal: `message === undefined` is a presence check and carries no claim
 * about what the message says.
 */
const MESSAGE_INSPECTION =
  /(?<!\btypeof\s)\bmessage\b\s*(?:===|!==|==|!=)\s*["'`]|\bmessage\b\s*\.\s*(?:includes|match|startsWith|endsWith|indexOf|search|test)\s*\(|\.\s*test\s*\(\s*[A-Za-z_$][\w$]*\.?message\b|\bswitch\s*\([^)]*\bmessage\b/;

export function messageInspections(file: string, source: string): Finding[] {
  return scan(file, source, MESSAGE_INSPECTION);
}

/*
 * Turning a quantity into a JavaScript number, or rounding one.
 *
 * SPEC-0005 REQ "The View Computes No Domain Values": the view "MUST NOT
 * perform arithmetic on quantities, power figures, producer counts, or any
 * other value the domain produces, including rounding".
 *
 * Arithmetic operators are not matched — `+` concatenates strings all over
 * this code and a checker that flagged it would be turned off within a week.
 * What is matched is every way a string becomes a number, which is the step
 * arithmetic on a quantity has to go through first.
 */
const NUMERIC_CONVERSION =
  /\bNumber\s*\(|\bparseInt\s*\(|\bparseFloat\s*\(|\bMath\s*\.|\.\s*toFixed\s*\(|\.\s*toPrecision\s*\(|\bBigInt\s*\(|[^=!<>]\+\s*(?:quantity|total|perUnit|applications)\b/i;

export function numericConversions(file: string, source: string): Finding[] {
  return scan(file, source, NUMERIC_CONVERSION);
}

/*
 * Navigating.
 *
 * SPEC-0005 Security Requirements → Redirect Validation: "The application
 * MUST NOT navigate to a URL taken from decoded state." The boundary is
 * where decoded state lives, so the rule enforced here is stronger and
 * simpler than the requirement: nothing in the boundary navigates at all.
 * A module with no route to `location` cannot be given one by a caller.
 */
const NAVIGATION =
  /\blocation\s*\.\s*(?:assign|replace|href)|\blocation\s*=|\bwindow\s*\.\s*open\s*\(|\.\s*(?:href|src|action)\s*=|\bhistory\s*\.\s*(?:pushState|replaceState)/;

export function navigations(file: string, source: string): Finding[] {
  return scan(file, source, NAVIGATION);
}

/*
 * Issuing a network request.
 *
 * SPEC-0009 REQ "Stage 1 Reaches No Network": nothing in the durable store
 * "MUST issue a network request", and the absence "MUST be checkable
 * mechanically rather than by review".
 *
 * This is the source half. It is deliberately the weaker of the two checks
 * and exists because it is the one that names the offending line: a source
 * scan says `durable-store.ts:212 fetch(...)`, where the runtime check can
 * only say that something under `src/store` reached the network.
 *
 * The runtime half in `tests/store/discipline.spec.ts` is what actually
 * carries the requirement, because a request can be issued through a
 * reference this pattern cannot see — `const f = globalThis["fet" + "ch"]`
 * defeats every regex ever written. Neither check is sufficient alone.
 *
 * `new Request(...)` and `new Response(...)` are not matched: constructing
 * either issues nothing, and a checker that fired on them would be reported
 * as a false positive and switched off within a week.
 */
const NETWORK_CALL =
  /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\s*\(|\bimportScripts\s*\(|\baxios\s*\./;

export function networkCalls(file: string, source: string): Finding[] {
  return scan(file, source, NETWORK_CALL);
}

/*
 * Marking a record as shared, synced, or queued for upload.
 *
 * SPEC-0009 REQ "Nothing Is Marked for Synchronization". This is a source
 * scan over key names and, like the one above, it is the weaker half — the
 * requirement is about what ends up *written*, and a field set through a
 * computed key would not appear here. `tests/store/discipline.spec.ts`
 * asserts on records read back out of IndexedDB for that reason.
 *
 * `updatedAt` and `revision` are NOT matched, and that is the point of the
 * requirement rather than an oversight in the pattern. ADR-0008 reserves
 * both for a later sync ADR, SPEC-0009 requires they be written from the
 * first version, and a checker that treated a reserved field as a marked
 * one would be arguing with the schema rather than enforcing it.
 */
const SYNC_MARKER =
  /\b(?:isShared|shared|isSynced|synced|syncState|syncedAt|pendingUpload|pendingSync|needsUpload|needsSync|uploadedAt|remoteId|publishedAt)\s*[:=]/;

export function syncMarkers(file: string, source: string): Finding[] {
  return scan(file, source, SYNC_MARKER);
}
