/*
 * Source-level stylesheet checks, written as pure functions over a string.
 *
 * Governing: SPEC-0005 REQ "Token Discipline", REQ "Component Styling
 * Discipline"
 *
 * They take a string rather than reading files so each one can be run twice:
 * once against the real stylesheet, and once against a deliberately broken
 * stylesheet written into the test. The second run is what makes the first
 * one worth anything — a checker that returns an empty array unconditionally
 * passes every clean stylesheet in the world, and only the broken input
 * catches that.
 *
 * stylelint and scripts/check-tokens.sh enforce the same two rules in CI.
 * These began as the only one of the three with a negative control — the
 * shell script had never been observed to reject anything, so nothing
 * distinguished "the stylesheet is clean" from "the pattern no longer
 * matches". It carries its own self-checks now, and strips comments as these
 * do, so the two no longer disagree about a colour named in prose. They stay
 * separate because a checker written as a pure function over a string can be
 * run against a broken stylesheet from a test, and a CI gate cannot.
 */

export interface Finding {
  line: number;
  text: string;
}

/** A CSS comment, so a rule named in prose is not read as a declaration. */
const COMMENT = /\/\*[\s\S]*?\*\//g;

/**
 * Blank out comments while preserving every newline, so a finding's reported
 * line number still points at the line it came from.
 */
function stripComments(source: string): string {
  return source.replace(COMMENT, (match) => match.replace(/[^\n]/g, " "));
}

function findings(source: string, test: (line: string) => boolean): Finding[] {
  const out: Finding[] = [];
  stripComments(source)
    .split("\n")
    .forEach((line, index) => {
      if (test(line)) {
        out.push({ line: index + 1, text: line.trim() });
      }
    });
  return out;
}

/*
 * The 148 CSS named colours are not enumerated. Only the ones a developer
 * reaches for by hand are, because the check's job is to catch a colour
 * written directly rather than to be a complete CSS parser — stylelint's
 * `color-named` covers the full list in the same CI run.
 */
const NAMED = [
  "black",
  "white",
  "red",
  "green",
  "blue",
  "yellow",
  "orange",
  "purple",
  "pink",
  "brown",
  "gray",
  "grey",
  "silver",
  "gold",
  "cyan",
  "magenta",
  "teal",
  "navy",
  "olive",
  "maroon",
  "lime",
  "aqua",
  "fuchsia",
  "beige",
  "ivory",
  "coral",
  "salmon",
  "khaki",
  "indigo",
  "violet",
  "tan",
  "crimson",
];

/*
 * Every syntax that can express a colour value directly:
 *
 *   - 3, 4, 6 or 8 hex digits after a #
 *   - the legacy and modern colour functions
 *   - a bare named colour, as a whole word after a `:` or a separator
 *
 * `color(`, `lab(`, `lch(` and `color-mix(` are included even though nothing
 * in the project uses them yet. The texture tokens already document wanting
 * `color-mix()`, and a check that only knows the syntaxes already in use
 * stops working the moment somebody reaches for a new one.
 */
const LITERAL = new RegExp(
  [
    "#[0-9a-fA-F]{3,8}\\b",
    "\\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\\(",
    `(?::|,|\\s)\\s*(?:${NAMED.join("|")})\\s*(?:;|,|\\)|$)`,
  ].join("|"),
);

/** Colour values written directly rather than referenced through a token. */
export function colourLiterals(source: string): Finding[] {
  return findings(source, (line) => LITERAL.test(line));
}

/** `box-shadow` with an `inset` keyword, in any position within the value. */
export function insetBoxShadows(source: string): Finding[] {
  return findings(source, (line) => /box-shadow\s*:[^;]*\binset\b/.test(line));
}

/*
 * Values that set a colour without naming one: they inherit, clear, or defer
 * to the text colour. None of them can carry a literal, so none of them needs
 * a token.
 */
const COLOURLESS = new Set([
  "inherit",
  "initial",
  "unset",
  "revert",
  "revert-layer",
  "transparent",
  "currentcolor",
  "none",
]);

/**
 * Colour-bearing declarations whose value does not resolve through a custom
 * property.
 *
 * Narrower than {@link colourLiterals} on purpose: this one covers the other
 * half of the requirement — not "is there a literal here" but "does every
 * component colour go through a token". A rule that dropped `var()` and left
 * the property inheriting a colour from somewhere else carries no literal and
 * would pass the first check while failing the requirement.
 */
export function untokenizedColourProperties(source: string): Finding[] {
  return findings(source, (line) => {
    /*
     * Not anchored to the start of the line: a declaration can follow a `{`
     * or another `;` on the same line, and a checker that only saw the first
     * one would miss it. Prettier puts one per line in this project, which is
     * exactly why the anchored version passed every real file while catching
     * nothing in a minified or hand-written one.
     */
    const match = /(?:^|[{;])\s*([a-z-]+)\s*:\s*([^;}]+)[;}]/.exec(line);
    if (!match) return false;

    const [, property = "", value = ""] = match;

    /*
     * Custom properties are skipped. A literal in a `--foo: #abc` declaration
     * is colourLiterals()'s finding, and this check is about whether a
     * component *consumes* colour through a token — which is a question about
     * the properties that paint, not the ones that define.
     */
    if (property.startsWith("--")) return false;

    const isColourBearing =
      /(^|-)color$/.test(property) || property === "fill" || property === "stroke";
    if (!isColourBearing) return false;

    if (value.includes("var(--")) return false;
    return !COLOURLESS.has(value.trim().toLowerCase());
  });
}
