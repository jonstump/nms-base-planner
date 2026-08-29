#!/usr/bin/env bash
# Governing: SPEC-0005 REQ "Token Discipline"
#
# "WHEN the stylesheet is searched for colour literals outside the token file
#  THEN none is found, and every component colour resolves through a custom
#  property."
#
# Stylelint enforces this for .css. This covers .ts/.tsx as well, where an
# inline style attribute is just as capable of carrying a literal and
# stylelint does not look.
#
# Two things this script used to get wrong, both fixed here.
#
# It scanned comments. A colour named in prose — React Flow's grey, in the
# sentence explaining why that grey is being overridden — failed the gate,
# so the only way to document a literal was to not name it. Meanwhile
# tests/helpers/css-checks.ts, enforcing the same rule in the same CI run,
# strips comments and carries an explicit test that "a literal inside a
# comment is not a finding". Two enforcers of one rule disagreeing is worse
# than either behaviour: it makes the rule a matter of which one you hit.
# Comments are stripped here now, and the two agree.
#
# And it had no negative control. css-checks.ts says so in its own header:
# "the shell script has never been observed to reject anything, so nothing
# distinguishes 'the stylesheet is clean' from 'the pattern no longer
# matches'." A clean tree and a broken pattern produce the same output. So
# the script now proves it can still see, against fixtures held right here,
# before it reports on the real files — and comment-stripping makes that
# more necessary rather than less, since over-stripping would silently
# blind it.
set -euo pipefail
cd "$(dirname "$0")/.."

python3 - <<'PY'
import re
import sys
from pathlib import Path

# 3, 4, 6 or 8 hex digits after a #, plus the CSS colour functions. The token
# file is the one place any of them is allowed.
PATTERN = re.compile(r"#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(")

# The other way a colour stops resolving through a token: reaching for a
# token that is not a colour. `color: var(--text-body)` looks exactly like
# discipline and is `color: 15px`, which the browser drops on the floor —
# the element silently inherits and nobody sees a failure. Six of these were
# live in canvas.css, including one inside a WCAG fix.
#
# The type scale is a closed set, so this names it rather than guessing at
# what is or is not a colour. A token added to that scale belongs here too.
SIZE_TOKENS = (
    "text-label",
    "text-meta",
    "text-body",
    "text-emphasis",
    "text-h3",
    "text-h2",
    "text-display",
    "display-floor",
)
COLOUR_PROPERTIES = r"color|background-color|border-color|outline-color|fill|stroke|caret-color|text-decoration-color|column-rule-color"
MISUSE = re.compile(
    rf"\b(?:{COLOUR_PROPERTIES})\s*:\s*var\(\s*--(?:{'|'.join(SIZE_TOKENS)})\b"
)

BLOCK = re.compile(r"/\*.*?\*/", re.S)
LINE = re.compile(r"^\s*(//|\*)")


def strip_comments(source: str) -> str:
    """Blank out comments, keeping every newline so line numbers still point
    at the line the finding came from.

    Block comments cover CSS and both TS forms. Line comments are removed
    only when `//` opens the line: a `//` mid-line is as likely to be inside
    a URL as to start a comment, and blanking the rest of that line could
    hide a literal sitting after it."""
    blanked = BLOCK.sub(lambda m: re.sub(r"[^\n]", " ", m.group(0)), source)
    return "\n".join("" if LINE.match(line) else line for line in blanked.split("\n"))


def findings(source: str) -> list[tuple[int, str]]:
    return [
        (number, line.strip())
        for number, line in enumerate(strip_comments(source).split("\n"), start=1)
        if PATTERN.search(line)
    ]


def misuses(source: str) -> list[tuple[int, str]]:
    return [
        (number, line.strip())
        for number, line in enumerate(strip_comments(source).split("\n"), start=1)
        if MISUSE.search(line)
    ]


# ----------------------------------------------------------------------
# The negative control, first, so a broken pattern cannot report a clean
# tree. Each case names what it is protecting.
# ----------------------------------------------------------------------
CASES: list[tuple[str, str, bool]] = [
    ("a hex literal in a declaration", "  color: #ff0000;", True),
    ("a short hex literal", "  color: #f00;", True),
    ("an rgb() literal", "  background: rgb(1 2 3);", True),
    ("an oklch() literal", "  color: oklch(0.5 0.1 200);", True),
    ("a literal in a JSX style object", '  style={{ color: "#abcdef" }}', True),
    ("a colour named in a block comment", "/* the library ships #808080 here */", False),
    (
        "a colour named across a multi-line block comment",
        "/*\n * The library ships\n * #808080 here.\n */",
        False,
    ),
    ("a colour named in a line comment", "  // the library ships #808080 here", False),
    ("an issue reference in a comment", "/* see #123 for why */", False),
    ("a token reference", "  color: var(--text-body);", False),
    # Over-stripping is the failure mode comment-stripping introduces, and it
    # is silent: a checker that blanks too much reports a clean tree forever.
    ("a literal on a line holding a URL", '  a = "https://x.example"; color: #ff0000;', True),
    ("a literal after a comment closes", "  /* note */ color: #ff0000;", True),
]

# The size-token-in-a-colour-slot check gets its own controls, including the
# near-misses: a size token in a size slot is correct, and a colour token in
# a colour slot is the whole point.
MISUSE_CASES: list[tuple[str, str, bool]] = [
    ("a size token as a colour", "  color: var(--text-body);", True),
    ("a size token as a background", "  background-color: var(--text-meta);", True),
    ("a size token as a border colour", "  border-color: var(--text-label);", True),
    ("a size token as an SVG fill", "  fill: var(--text-emphasis);", True),
    ("a size token in a size slot", "  font-size: var(--text-body);", False),
    ("a colour token in a colour slot", "  color: var(--text);", False),
    ("a colour token whose name starts the same", "  color: var(--text-bright);", False),
    ("a muted colour token", "  color: var(--text-muted);", False),
    ("a size token named in a comment", "/* color: var(--text-body) was wrong */", False),
]

broken = [
    f"  {name}: expected {'a finding' if want else 'no finding'}"
    for name, source, want in CASES
    if bool(findings(source)) != want
] + [
    f"  {name}: expected {'a finding' if want else 'no finding'}"
    for name, source, want in MISUSE_CASES
    if bool(misuses(source)) != want
]

if broken:
    print("The colour checks cannot see what they are for:")
    print("\n".join(broken))
    print()
    print("Fix the patterns or the comment stripping before trusting a clean run.")
    sys.exit(1)

# ----------------------------------------------------------------------
# The real files.
# ----------------------------------------------------------------------
TOKEN_FILE = Path("src/styles/tokens.css")

offenders: list[str] = []
misused: list[str] = []
scanned = 0
for path in sorted(Path("src").rglob("*")):
    if path.suffix not in {".ts", ".tsx", ".css"} or path == TOKEN_FILE:
        continue
    scanned += 1
    source = path.read_text()
    for number, text in findings(source):
        offenders.append(f"{path}:{number}:{text}")
    for number, text in misuses(source):
        misused.append(f"{path}:{number}:{text}")

if scanned == 0:
    print("No source files were scanned — the check found nothing to look at.")
    sys.exit(1)

failed = False

if offenders:
    print("Colour literals found outside src/styles/tokens.css:")
    print("\n".join(offenders))
    print()
    print("Add the value to the token file with its design provenance, or")
    print("reference an existing custom property.")
    failed = True

if misused:
    if offenders:
        print()
    print("Type-scale tokens used as colours (the browser drops these):")
    print("\n".join(misused))
    print()
    print("These look like token discipline and are not — `color: var(--text-body)`")
    print("is `color: 15px`, which is invalid, so the element silently inherits.")
    print("Use a colour token: --text, --text-bright, --text-muted, or a state token.")
    failed = True

if failed:
    sys.exit(1)

checks = len(CASES) + len(MISUSE_CASES)
print(f"No colour literals and no type-scale tokens in colour slots ({scanned} files, {checks} self-checks).")
PY
