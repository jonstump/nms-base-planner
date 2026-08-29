#!/usr/bin/env bash
# Governing: SPEC-0005 REQ "Token Discipline", REQ "Component Styling
# Discipline", Accessibility Requirements
#
# "Each test fails against a deliberately broken stylesheet, checked by
#  breaking it rather than assumed." (issue #61)
#
# "Every focus-return route is tested separately — a single 'close the
#  popover' test would pass while two of the three routes are broken."
#  (issue #62)
#
# #61 covered the stylesheet. #62 extends the same treatment to the
# accessibility primitives, because the same argument applies and more
# sharply: a focus trap that has stopped restoring focus looks identical on
# screen to one that works.
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
TRAP="src/a11y/useFocusTrap.ts"
LIVE="src/a11y/useLiveRegion.ts"
SHELL="src/shell/AppShell.tsx"
BADGE="src/shell/StatusBadge.tsx"
STORE="src/store/durable-store.ts"
MODEL="src/canvas/graph-model.ts"
EDGE="src/canvas/TreeEdge.tsx"
CARD="src/canvas/NodeCard.tsx"
CANVAS="src/styles/canvas.css"

MUTABLE="$BASE $TOKENS $TRAP $LIVE $SHELL $BADGE $STORE $MODEL $EDGE $CARD $CANVAS"

# shellcheck disable=SC2086
restore() { git checkout -- $MUTABLE 2>/dev/null || true; }
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

# ----------------------------------------------------------------------
# Accessibility primitives.
#
# The focus-trap mutations are the ones worth reading. "Escape-only restore"
# is not a strawman — it is the natural way to write it, and it leaves the
# Escape test green while the backdrop and close-control tests go red. That
# is the whole reason issue #62 words the criterion around routes.
# ----------------------------------------------------------------------

check "focus is never returned on close" \
  tests/shell/a11y-primitives.spec.ts "$TRAP" \
  "      if (target?.isConnected) target.focus();" \
  "      void target;"

check "focus is restored only by the Escape handler" \
  tests/shell/a11y-primitives.spec.ts "$TRAP" \
  "      if (target?.isConnected) target.focus();" \
  "      void target;
      // the Escape-only implementation restores here instead"

check "the focus trap stops containing Tab" \
  tests/shell/a11y-primitives.spec.ts "$TRAP" \
  "      if (event.key !== \"Tab\") return;" \
  "      if (event.key !== \"Tab\") return;
      return;"

check "the live region announces on first render too" \
  tests/shell/a11y-primitives.spec.ts "$LIVE" \
  "    if (first || !changed || token === null) return;" \
  "    if (!changed) return;"

check "the live region announces on every render" \
  tests/shell/a11y-primitives.spec.ts "$LIVE" \
  "    if (first || !changed || token === null) return;" \
  "    if (false) return;"

check "a landmark goes missing" \
  tests/shell/shell.spec.ts "$SHELL" \
  '      <footer className="shell-footer">' \
  '      <div className="shell-footer">'

check "the navigation landmark loses its name" \
  tests/shell/shell.spec.ts "$SHELL" \
  '      <nav className="shell-nav" aria-label="Surfaces">' \
  '      <nav className="shell-nav">'

check "a status loses the word beside its colour" \
  tests/shell/a11y-baseline.spec.ts "$BADGE" \
  '  ok: { tokenClass: "status-ok", glyph: "✓", label: "OK" },' \
  '  ok: { tokenClass: "status-ok", glyph: "✓", label: "" },'

check "two statuses become indistinguishable without colour" \
  tests/shell/a11y-baseline.spec.ts "$BADGE" \
  '  unverified: { tokenClass: "status-unverified", glyph: "?", label: "Unverified" },' \
  '  unverified: { tokenClass: "status-unverified", glyph: "?", label: "Pending" },'

check "a control is named only by a glyph" \
  tests/shell/a11y-baseline.spec.ts "$SHELL" \
  '        <button type="submit" className="control control-primary interactive">
          Recompute
        </button>' \
  '        <button type="submit" className="control control-primary interactive">
          →
        </button>'

# ----------------------------------------------------------------------
# The durable store's two absences.
#
# SPEC-0009 REQ "Stage 1 Reaches No Network" and REQ "Nothing Is Marked for
# Synchronization" are both claims that something never happens, and a suite
# that only exercises the store cannot distinguish "no request was issued"
# from "no test looked". These two are the ones issue #112 names.
#
# Both mutations are type errors the compiler would reject. That is not a
# gap: vite strips types without checking them, so the mutated store runs,
# and a rule that only `tsc` enforces is a rule that stops being enforced
# the moment someone reaches for `as unknown as`.
# ----------------------------------------------------------------------

check "the store fetches something on write" \
  tests/store/discipline.spec.ts "$STORE" \
  '      const now = this.#now();
      const transaction = db.transaction([WORKSPACE_STORE, PLACES_STORE], "readwrite");' \
  '      const now = this.#now();
      await fetch("/api/places", { method: "POST", body: place.id });
      const transaction = db.transaction([WORKSPACE_STORE, PLACES_STORE], "readwrite");'

# The one that earns the runtime layer its place. Both mutations above trip
# the source scan *and* the runtime check, so neither shows the runtime check
# is doing anything. This one is invisible to any regex — verified: with it
# applied, "no store source reaches for a network primitive" passes and
# "nothing goes out" fails. Delete the runtime check and this goes green.
check "the store fetches through a name the source scan cannot see" \
  tests/store/discipline.spec.ts "$STORE" \
  '      const now = this.#now();
      const transaction = db.transaction([WORKSPACE_STORE, PLACES_STORE], "readwrite");' \
  '      const now = this.#now();
      const send = (globalThis as Record<string, unknown>)["fet" + "ch"] as (
        url: string,
      ) => Promise<unknown>;
      await send("/api/places");
      const transaction = db.transaction([WORKSPACE_STORE, PLACES_STORE], "readwrite");'

check "a written place is pre-marked as synced" \
  tests/store/discipline.spec.ts "$STORE" \
  "      const record: PlaceRecord = {
        ...place,
        schemaVersion: SCHEMA_VERSION," \
  "      const record: PlaceRecord = {
        ...place,
        synced: false,
        schemaVersion: SCHEMA_VERSION,"

# ----------------------------------------------------------------------
# The tree canvas.
#
# SPEC-0006 carves layout out of SPEC-0005's no-arithmetic rule and draws
# the line at what the engine may read. design.md is explicit that the line
# exists so the argument does not have to be had at review time on every
# surface — which only works if something is watching it.
#
# The ordering mutation is the one worth reading. A payload that arrived
# already sorted would satisfy every ordering assertion against a canvas
# that sorted it again, so the source scan and the rendered order are both
# needed and this breaks both at once.
# ----------------------------------------------------------------------

check "the canvas sorts the nodes it was given" \
  tests/canvas/rendering.spec.ts "$MODEL" \
  "  for (const node of graph.nodes) {" \
  "  for (const node of [...graph.nodes].sort((a, b) => a.name.localeCompare(b.name))) {"

check "a total reaches the layout engine" \
  tests/canvas/layout.spec.ts "$MODEL" \
  "    nodes: model.nodes.map((node) => ({
      id: node.id,
      width: NODE_WIDTH," \
  "    nodes: model.nodes.map((node) => ({
      id: node.id,
      total: node.total,
      width: NODE_WIDTH,"

check "node width is derived from the total" \
  tests/canvas/layout.spec.ts "$MODEL" \
  "      width: NODE_WIDTH," \
  "      width: NODE_WIDTH + node.total.length * 3,"

check "an edge stops showing its per-unit quantity" \
  tests/canvas/edges.spec.ts "$EDGE" \
  "          {perUnit}" \
  '          {""}'

check "edge styling stops distinguishing a refine step" \
  tests/canvas/edges.spec.ts "$CANVAS" \
  '.tree-edge[data-method="refine"] {
  stroke: var(--accent-border);
  stroke-dasharray: 6 4;
}' \
  '.tree-edge[data-never-matches="refine"] {
  stroke: var(--accent-border);
  stroke-dasharray: 6 4;
}'

# The other half of "no fact lives only in an edge": if the card stops
# naming the method, the edge's stroke becomes the sole carrier of it.
check "the node card stops naming its method" \
  tests/canvas/edges.spec.ts "$CARD" \
  '<span className="node-method">{node.method}</span>' \
  '<span className="node-method" />'

echo
if [ "$failures" -gt 0 ]; then
  echo "$failures mutation(s) did not turn the suite red. Those rules are unwatched."
  exit 1
fi
echo "Every mutation turned the suite red."
