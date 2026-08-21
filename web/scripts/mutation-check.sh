#!/usr/bin/env bash
# Governing: SPEC-0005 REQ "Token Discipline", REQ "Component Styling Discipline"
#
# "Each test fails against a deliberately broken stylesheet, checked by
#  breaking it rather than assumed." (issue #61)
#
# A passing suite proves the stylesheet is not broken in the ways the suite
# knows how to look for. It does not prove the suite can see anything at all —
# a selector that stopped matching, a helper that returns an empty array, an
# emulation that silently does not take, all pass every assertion forever.
#
# So each mutation below breaks the stylesheet in exactly one way and names
# the test that must go red. A mutation that leaves the suite green is a
# failure of this script: it means nothing is watching that rule.
#
# It runs in CI. Breaking the stylesheet by hand once, before opening a PR,
# proves it about that afternoon and nothing after.
set -uo pipefail
cd "$(dirname "$0")/.."

BASE="src/styles/base.css"
TOKENS="src/styles/tokens.css"

restore() { git checkout -- "$BASE" "$TOKENS" 2>/dev/null || true; }
trap restore EXIT

# mutate <file> <python-expression-safe-old> <new>
mutate() {
  python3 - "$1" "$2" "$3" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
source = open(path).read()
if old not in source:
    sys.exit(f"mutation anchor not found in {path}: {old!r}")
open(path, "w").write(source.replace(old, new, 1))
PY
}

failures=0

# check <name> <spec> <file> <old> <new>
check() {
  local name="$1" spec="$2" file="$3" old="$4" new="$5"
  restore
  if ! mutate "$file" "$old" "$new"; then
    echo "FAIL  $name — could not apply the mutation (the stylesheet moved under it)"
    failures=$((failures + 1))
    return
  fi

  if npx playwright test "$spec" --reporter=dot >/dev/null 2>&1; then
    echo "FAIL  $name — the suite still passed, so no test is watching this"
    failures=$((failures + 1))
  else
    echo "ok    $name — $spec went red"
  fi
  restore
}

echo "Breaking the stylesheet one rule at a time."
echo

check "hover stops being a filter" \
  tests/interaction-states.spec.ts "$BASE" \
  "  filter: brightness(var(--hover-brightness));" \
  "  opacity: 0.9;"

check "focus becomes a border instead of an outline" \
  tests/interaction-states.spec.ts "$BASE" \
  "  outline: var(--focus-ring-width) solid var(--ok);" \
  "  border-color: var(--ok);"

check "the focus ring moves inboard" \
  tests/interaction-states.spec.ts "$BASE" \
  "  outline-offset: var(--focus-ring-offset);" \
  "  outline-offset: -2px;"

check "the selection overlay loses its stacking position" \
  tests/selection-ring.spec.ts "$BASE" \
  "  z-index: 1;" \
  "  z-index: auto;"

# The real defect, not a shadow moved onto the overlay: the overlay is deleted
# and the ring is drawn on the card itself, where it paints into the background
# layer beneath every positioned child.
check "selection becomes an inset box-shadow on the card" \
  tests/selection-ring.spec.ts "$BASE" \
  '.selectable[aria-selected="true"]::after,
.selectable[data-selected="true"]::after {
  content: "";' \
  '.selectable[aria-selected="true"],
.selectable[data-selected="true"] {
  box-shadow: inset 0 0 0 2px var(--ok);
}

.selectable[data-never-matches="true"]::after {
  content: "";'

check "the selectable element stops establishing a containing block" \
  tests/selection-ring.spec.ts "$BASE" \
  ".selectable {
  position: relative;
}" \
  ".selectable {
  position: static;
}"

check "a colour literal appears outside the token file" \
  tests/stylesheet.spec.ts "$BASE" \
  "  color: var(--text-muted);" \
  "  color: #a89984;"

check "an inset box-shadow appears anywhere" \
  tests/stylesheet.spec.ts "$BASE" \
  "  background-color: var(--panel);" \
  "  background-color: var(--panel);
  box-shadow: inset 0 0 0 1px var(--border);"

check "the two control steps collapse into one" \
  tests/control-scale.spec.ts "$TOKENS" \
  "  --control-height-sm: 30px;" \
  "  --control-height-sm: 40px;"

check "a row mixes the two steps" \
  tests/control-scale.spec.ts "$BASE" \
  ".control-row-sm > .control {
  height: var(--control-height-sm);" \
  ".control-row-sm > .control:first-child {
  height: var(--control-height);
}

.control-row-sm > .control {
  height: var(--control-height-sm);"

check "the coarse-pointer target shrinks below 44px" \
  tests/control-scale.spec.ts "$BASE" \
  "    min-height: var(--target-coarse);" \
  "    min-height: 40px;"

echo
if [ "$failures" -gt 0 ]; then
  echo "$failures mutation(s) did not turn the suite red. Those rules are unwatched."
  exit 1
fi
echo "Every mutation turned the suite red."
