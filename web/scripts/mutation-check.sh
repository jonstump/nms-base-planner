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
LAYOUT="src/canvas/layout.ts"
TREE="src/canvas/TreeCanvas.tsx"

MUTABLE="$BASE $TOKENS $TRAP $LIVE $SHELL $BADGE $STORE $MODEL $EDGE $CARD $CANVAS"
METHODS="src/canvas/methods.ts"
CONTROL="src/canvas/NodeControl.tsx"

ASSIGN="src/canvas/useLeafAssignment.ts"
BASES="src/canvas/bases.ts"

RESOLVE="src/state/assignments.ts"
STORED="src/state/useStoredData.ts"
PLANNERCARD="src/card/BasePlannerCard.tsx"
POWERBLOCK="src/card/PowerBlock.tsx"

MUTABLE="$MUTABLE $LAYOUT $TREE $METHODS $CONTROL $ASSIGN $BASES $PLANNERCARD $POWERBLOCK"
MUTABLE="$MUTABLE $RESOLVE $STORED"

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

  # --timeout is the per-test timeout, below the 30s default because every run
  # here is expected to go red and waiting is the dominant cost of doing so.
  #
  # What it actually bounds: a single waiting assertion is capped by the
  # *expect* timeout, which is 5s and which this flag does not change —
  # playwright.config.ts sets neither. The test timeout binds when one test
  # accumulates several such waits. So a mutation that breaks a computed value
  # (a colour literal, an inset shadow, a control step) fails the instant the
  # assertion is evaluated, while one that breaks an element's identity leaves
  # each dependent assertion waiting out its 5s.
  #
  # 8s is chosen against the slowest single *test* in the specs this script
  # runs, not against the suite's wall time — the suite total is a different
  # quantity and does not license lowering this further as the suite gets
  # faster.
  #
  # Before lowering it, note what the check cannot see: `check` reads only the
  # exit code, so a red from a timeout and a red from an assertion are
  # indistinguishable to it. A timeout tight enough to cut off a slow but
  # correct test would report that mutation `ok` for the wrong reason — the
  # same false-pass class the landmark mutation below was an instance of. The
  # margin here is the safeguard, not slack to reclaim.
  if npx playwright test "$spec" --timeout=8000 --reporter=dot >/dev/null 2>&1; then
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

# Both tags are renamed, not just the opening one. Renaming `<footer>` alone
# leaves `</footer>` unmatched, which is a syntax error (TS17002) rather than a
# missing landmark: AppShell.tsx stops compiling, the page never renders, and
# every locator in the spec waits out its timeout. That went red for the wrong
# reason — it would have gone red with no landmark assertion in the suite at
# all, which is precisely the thing this script exists to rule out — and it
# cost ~70s of CI on each of two observed runs while proving nothing.
#
# The anchor spans the whole element because `check` performs one substitution,
# and both tags have to move together. That couples this mutation to the
# footer's user-facing copy: an editorial change to that sentence breaks the
# anchor. It breaks loudly — `mutation anchor not found`, then FAIL — so it is
# a maintenance cost rather than a way to fail open.
check "a landmark goes missing" \
  tests/shell/shell.spec.ts "$SHELL" \
  '      <footer className="shell-footer">
        <p className="label">
          Figures come from the planner module. Nothing on this page is computed here.
        </p>
      </footer>' \
  '      <div className="shell-footer">
        <p className="label">
          Figures come from the planner module. Nothing on this page is computed here.
        </p>
      </div>'

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
#
# The same breakage as "the method badge loses its word" below, named
# against a different suite on purpose. That one asks whether the badge
# still carries a word; this one asks whether the fact an edge's stroke
# conveys is still text somewhere. Two requirements, one way to break both,
# and a mutation that only named one of the suites would let the other rot.
check "the node card stops naming its method" \
  tests/canvas/edges.spec.ts "$CARD" \
  "      <span>{method}</span>" \
  "      <span />"

# ----------------------------------------------------------------------
# The three findings from the review of #124.
#
# Each was a guard that could not fire, and each was found by breaking the
# thing it guarded and watching the suite stay green. These are those three
# breakages, kept.
# ----------------------------------------------------------------------

# The canvas arrives after the figure list — behind a lazy chunk and then a
# layout — so an audit that waits only for the list analyses a document the
# canvas is not in yet. React Flow's attribution fails AA against this
# surface at 1.12; before the wait in resolveAPlan, removing the restyle
# left the audit green.
check "React Flow's attribution goes back to shipping unreadable" \
  tests/shell/shell.spec.ts "$CANVAS" \
  '.tree-canvas .react-flow__attribution {
  background-color: var(--panel);
}' \
  '.tree-canvas .react-flow__attribution-unmatched {
  background-color: var(--panel);
}'

# SPEC-0009 makes the separator preference outlive the page; the canvas has
# to honour it, and while the flat list is on screen beside it a hardcoded
# separator shows the same figure two ways at once.
check "the canvas hardcodes its digit separator again" \
  tests/canvas/rendering.spec.ts "$TREE" \
  "            groupSeparator: preferences.groupSeparator," \
  '            groupSeparator: ",",'

# An engine that would not load used to return an empty map, which the
# canvas could not tell from a laid-out graph — so every card took the
# fallback coordinate and the tree rendered as one pile at the origin.
check "a failed layout becomes indistinguishable from an empty one" \
  tests/canvas/degraded.spec.ts "$LAYOUT" \
  "  } catch {
    return null;
  }" \
  "  } catch {
    return new Map();
  }"

# ----------------------------------------------------------------------
# The node card: identity, yield and provenance.
#
# Three of these break a rule that had no way to fail before this story —
# the card could not be hovered at all, so "hover is a filter" was kept by
# nobody; and the artifact marks nothing unverified, so the provenance
# treatment was unreachable from the application.
# ----------------------------------------------------------------------

check "the method badge loses its glyph" \
  tests/canvas/node-card.spec.ts "$CARD" \
  '  raw: "▽",
  craft: "⚒",
  refine: "◇",' \
  '  raw: "",
  craft: "",
  refine: "",'

# The other half: the glyph alone is a colour-and-shape carrier with no word.
check "the method badge loses its word" \
  tests/canvas/node-card.spec.ts "$CARD" \
  "      <span>{method}</span>" \
  "      <span />"

check "a fractional application count is rounded up to a whole operation" \
  tests/canvas/node-card.spec.ts "$TREE" \
  "          applicationsDisplay:
            node.applications === null
              ? null" \
  "          applicationsDisplay:
            node.applications === null
              ? null
              : node.applications.includes(\"/\")
                ? String(Math.ceil(Number(node.applications.split(\"/\")[0]) / Number(node.applications.split(\"/\")[1])))"

check "the recipe yield stops reaching the card" \
  tests/canvas/node-card.spec.ts "$TREE" \
  "          yieldDisplay:
            node.recipeYield === null || node.recipeYield === \"1\"" \
  "          yieldDisplay:
            true || node.recipeYield === null || node.recipeYield === \"1\""

# SPEC-0006: the unassigned state must not rest on the border alone.
check "an unassigned leaf is left with only its dashed border" \
  tests/canvas/node-card.spec.ts "$CARD" \
  "        {node.terminal && identity === undefined && (" \
  "        {false && node.terminal && identity === undefined && ("

# SPEC-0006: the marker "MUST NOT be styled as an error state".
check "provenance takes the treatment reserved for something to fix" \
  tests/canvas/node-card.spec.ts "$CANVAS" \
  "  border: var(--border-width) dashed var(--text-muted); /* 4.72, non-text needs 3.0 */" \
  "  border: var(--border-width) solid var(--danger);"

# The card was unreachable by pointer until this story; nothing noticed.
check "the pane goes back to swallowing the pointer" \
  tests/canvas/node-card.spec.ts "$CANVAS" \
  "  pointer-events: auto;" \
  "  pointer-events: none;"

# The border is base identity's and nothing else may write to it.
check "something other than base identity writes to the card border" \
  tests/canvas/node-card.spec.ts "$BASE" \
  ".identity {
  border: var(--border-width-identity) solid var(--border);
}" \
  ".identity {
  border: var(--border-width) solid var(--border);
}"

# ----------------------------------------------------------------------
# The node's method control.
#
# SPEC-0006 REQ "Method Selection" is two claims that a behavioural test
# cannot separate on its own: the options come from the payload, and an
# unavailable one is present-and-inert rather than absent. A canvas that
# computed legality and happened to agree with the payload passes every
# rendering assertion, so the first mutation makes it disagree.
# ----------------------------------------------------------------------

check "the control decides legality instead of reading it" \
  tests/canvas/method-control.spec.ts "$METHODS" \
  "    const available = legal.has(method);" \
  "    const available = true;"

check "an unavailable method is hidden rather than rendered inert" \
  tests/canvas/method-control.spec.ts "$CONTROL" \
  "          {options.map((option) => (" \
  "          {options.filter((shown) => shown.available).map((option) => ("

check "an inert option stops saying why" \
  tests/canvas/method-control.spec.ts "$CONTROL" \
  "          .filter((option) => option.reason !== null)" \
  "          .filter(() => false)"

check "the card stops opening its control" \
  tests/canvas/method-control.spec.ts "$CARD" \
  "          onOpen(node.id);" \
  "          void node.id;"

check "a method change stops recomputing through the boundary" \
  tests/canvas/method-control.spec.ts "$SHELL" \
  "      recomputeWith(next);" \
  "      void next;"

check "the announcement stops naming what changed" \
  tests/canvas/method-control.spec.ts "$SHELL" \
  "    const change = pendingChange.current;" \
  "    const change: string | null = null;"

# ----------------------------------------------------------------------
# Leaf assignment.
#
# The first mutation is the bug this story actually shipped and a test
# caught: skipping the dispatch when the map goes empty suppresses the
# *clear*, which is a real change — a leaf no longer gathered at a base
# changes that base's totals exactly as reassigning it does.
# ----------------------------------------------------------------------

check "clearing an assignment stops recomputing" \
  tests/canvas/assignment.spec.ts "$ASSIGN" \
  "    if (constants === null) return;" \
  "    if (constants === null || Object.keys(next).length === 0) return;"

check "the rollup goes out without the assignment on it" \
  tests/canvas/assignment.spec.ts "$ASSIGN" \
  "        assignments: resolveAssignments(next, placeIds).assignments," \
  "        assignments: {},"

check "a non-leaf is offered a base it cannot be gathered at" \
  tests/canvas/assignment.spec.ts "$CONTROL" \
  "      {node.terminal && (" \
  "      {(node.terminal || true) && ("

check "an assigned leaf stops taking its base colour" \
  tests/canvas/assignment.spec.ts "$BASES" \
  "  return bases.find((base) => base.id === id)?.slot;" \
  "  return undefined;"

check "the assignment announcement stops naming the base" \
  tests/canvas/assignment.spec.ts "$SHELL" \
  "      const label = bases.find((base) => base.id === baseId)?.label;" \
  "      const label: string | undefined = undefined;"

# ----------------------------------------------------------------------
# The absences the test stories asked for and nothing was enforcing.
#
# `numericConversions` catches Number()/parseInt/Math., and deliberately not
# `-` or `/`. So "no quantity-divided-by-rate appears in the card's source"
# was written at the top of tests/card/discipline.spec.ts and enforced by
# nothing, and "no subtraction of draw from generation" had only a rendered
# assertion — which cannot tell a computed balance from the payload's when
# the two agree, and they always will.
# ----------------------------------------------------------------------

check "the card computes a plant count it was given" \
  tests/card/discipline.spec.ts "$PLANNERCARD" \
  '        <Figure label="Plants" value={q(row.plants)} />' \
  '        <Figure label="Plants" value={q(row.required / row.yieldPerPlant.min)} />'

check "the card subtracts draw from generation" \
  tests/card/discipline.spec.ts "$POWERBLOCK" \
  '        <Figure label="Balance" value={formatQuantity(budget.balance)} />' \
  '        <Figure label="Balance" value={formatQuantity(budget.generation - budget.draw)} />'

# The two payloads differ in one boolean. A card that stated the unsizeable
# fix whenever the count was zero would pass every other power assertion.
check "an unsizeable fix is claimed for a fix the domain sized" \
  tests/card/power.spec.ts "$POWERBLOCK" \
  "  const sized = budget.inDeficit && !budget.fixUnsized;" \
  "  const sized = false;"

# ----------------------------------------------------------------------
# Places are first-class.
#
# Governing: ADR-0010, SPEC-0011 REQ "A Place Is Authored, and a Plan
# References It", REQ "An Assignment Naming an Absent Place Is Unassigned",
# REQ "A Place Is Creatable by Hand"
#
# Three rules a behavioural test alone cannot pin down, because each has a
# passing-looking implementation that is wrong:
#
#   - a place id derived from the name renders identically until a rename
#   - an assignment resolver that keeps everything looks right until a
#     place is deleted
#   - a card that shows the site's zeros looks like a configured base
# ----------------------------------------------------------------------

check "a place takes an id derived from its name instead of a generated one" \
  tests/shell/places.spec.ts "$STORED" \
  "        id: crypto.randomUUID()," \
  "        id: trimmed.toLowerCase().replace(/ /gu, \"-\"),"

check "an assignment naming a deleted place is kept rather than unassigned" \
  tests/canvas/assignment.spec.ts "$RESOLVE" \
  "    if (exists.has(baseId)) {" \
  "    if (true) {"

check "the unsited rows stop being rendered at all" \
  tests/card/composition.spec.ts "$PLANNERCARD" \
  "      {base.unsited.length > 0 ? (" \
  "      {false ? ("

echo
if [ "$failures" -gt 0 ]; then
  echo "$failures mutation(s) did not turn the suite red. Those rules are unwatched."
  exit 1
fi
echo "Every mutation turned the suite red."
