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

broken = [
    f"  {name}: expected {'a finding' if want else 'no finding'}"
    for name, source, want in CASES
    if bool(findings(source)) != want
]

if broken:
    print("The colour-literal check cannot see what it is for:")
    print("\n".join(broken))
    print()
    print("Fix the pattern or the comment stripping before trusting a clean run.")
    sys.exit(1)

# ----------------------------------------------------------------------
# The real files.
# ----------------------------------------------------------------------
TOKEN_FILE = Path("src/styles/tokens.css")

offenders: list[str] = []
scanned = 0
for path in sorted(Path("src").rglob("*")):
    if path.suffix not in {".ts", ".tsx", ".css"} or path == TOKEN_FILE:
        continue
    scanned += 1
    for number, text in findings(path.read_text()):
        offenders.append(f"{path}:{number}:{text}")

if scanned == 0:
    print("No source files were scanned — the check found nothing to look at.")
    sys.exit(1)

if offenders:
    print("Colour literals found outside src/styles/tokens.css:")
    print("\n".join(offenders))
    print()
    print("Add the value to the token file with its design provenance, or")
    print("reference an existing custom property.")
    sys.exit(1)

print(f"No colour literals outside the token file ({scanned} files, {len(CASES)} self-checks).")
PY
