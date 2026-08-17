# Handoff: Tree Canvas (NMS Base & Resource Planner)

> Convention note: where this document and a later spec disagree, **the spec wins**.

## Overview
The dependency-tree surface: pick a target item + quantity, see the full crafting/refining tree as a left-to-right flowchart, toggle method per node, assign leaf resources to bases. Prototyped with the **real Stasis Device tree — 34 nodes** (Quantum Processor + Cryogenic Chamber + Iridesite branches), quantities per 1 device.

**No "buy" method** (user decision): this is a build planner, not a shopping list. Methods are craft / refine / raw.

## About the Design Files
`Tree Canvas.dc.html` is a **design reference created in HTML**, not production code. Production: React Flow (`@xyflow/react`) custom HTML/CSS nodes + elkjs auto-layout (layered, left-to-right, raws leftmost). The prototype's hand-tuned column layout stands in for elkjs; its SVG edges stand in for React Flow edge routing. Pan/zoom is React Flow's; the prototype scrolls.

## Fidelity
High-fidelity for node cards, edges, popover, states, colors (all mapped to `docs/design/theme/` tokens). Layout positions are illustrative — elkjs decides in production.

## Node card
- 178px wide, `--panel-raised` #3c3836 bg, radius 2px, padding 8×10.
- Name (Space Grotesk 500 12.5px `--text-bright`), total qty (JetBrains Mono 12px tabular, `--text`), method badge (mono 9.5px caps: ▽ RAW / ⚒ CRAFT / ◇ REFINE, on `--input-bg`).
- **Leaf frame = assigned base color, 3px** (`--base-*`). Unassigned leaf: 3px dashed `--border` + `--warn` dot. Non-leaf: 1px `--border`.
- **Nothing else writes to the border** (outfitter #132): hover = `filter:brightness(1.12)`, focus = 2px `--ok` outline outboard, selected = 2px `--ok` ring **inboard** (overlay element, not inset box-shadow — inset shadows paint under positioned children; outfitter PR #180).
- `unverified` badge: dashed 1px chip, `--text-muted`, title text "community data, not verified in-game" — subtle, honest, non-alarming.

## Method popover (core interaction)
- Opens on click / Enter. Segmented craft|refine (30px small step); disabled option rendered but inert with reason. Preview line states the consequence ("refiner ratio differs: 300 gas → 1, no Condensed Carbon").
- Leaves get an assign-to-base `<select>` instead (dropdown chosen over drag per brief; drag leaf-chips onto base cards noted as enhancement).
- Method changes recompute edge styles + announce via `aria-live="polite"`.

## Edges
- 1.5px `--border`-colored beziers, quantity label (mono 10px `--text-muted`) at midpoint.
- **Inputs to a refine-method node are dashed** (5 4) — method is readable from the wiring, not just the badge.

## Density / layout
- 6 layers: 14 raws → 10 tier-1 → 4 tier-2 → 2 tier-3 → 3 components → device. Column x fixed, ~62px vertical rhythm in the raw column.
- Sample base assignment: crops → Verdant Moon (blue), gases+carbon → Gasworks (copper), minerals → Cobalt Flats (purple).

## Keyboard & a11y
- Nodes are `<button>`s in topological order (raws first, device last) = tab order. Enter/Space opens the popover; Escape closes (prototype: close button + backdrop click; production must trap focus in popover and return it to the node).
- Recompute announcements: `aria-live="polite"` region, e.g. "Enriched Carbon set to refine. Totals updated."
- Base assignment fully operable via the popover select (no pointer needed).
- Color never sole carrier: method has glyph+text, base identity has the name in the popover/base panel, unassigned has the ⚠ dot + popover text.

## State management notes
- Node method + leaf assignment are plan state (URL-hash-shareable per brief; **no localStorage in prototypes** — persistence expectations: plan serializes into the share hash).
- Tweaks panel exposes device quantity (×1–×10) — all totals scale; production recomputes via the dependency graph.

## Data (verified against community sources, 2026-08)
Stasis Device = Quantum Processor + Cryogenic Chamber + Iridesite. QP = Circuit Board (Heat Capacitor: 100 Frost Crystal + 200 Solanium; Poly Fibre: 100 Cactus Flesh + 200 Star Bulb) + Superconductor (Semiconductor: Thermic Condensate + Nitrogen Salt; + Enriched Carbon). CryoChamber = Living Glass (5 Glass: 200 Frost Crystal; Lubricant: 50 Faecium + 400 Gamma Root) + Cryo-Pump (Hot Ice: Nitrogen Salt + Enriched Carbon; + Thermic Condensate). Gas products: 250 gas + 50 Condensed Carbon each (×2 each → 500 Sulphurine/Nitrogen/Radon, 300 CC). Iridesite = Aronium (50 Paraffinium + 50 Ionised Cobalt) + Magno-Gold (50 Phosphorus + …) + Grantine (50 Dioxite + …). Glass and Hot Ice carry the `unverified` badge in the prototype as the worked example (refiner-variant ratios differ by source).

## Open questions
1. Edge labels at 34 nodes are legible; at 60+ (Fusion Ignitor + Stasis combined) labels may need hover-only. Flag for elkjs spacing tests.
2. Popover vs side-panel for method control on phone — phone is view-only per brief, so deferred to app-shell surface.

## Self-critique / WCAG 2.1 AA findings
- Edge labels `--text-muted` on `--bg-canvas` = 5.9:1 ✓; edge strokes are decorative reinforcement (badge carries the fact) ✓.
- Focus outline `--ok` on `--bg-canvas` 7.0:1 ✓. Node buttons ≥44px tall at zoom 1? They are 52px — ✓.
- Fixed: unassigned-leaf state initially color-only (dashed border); added ⚠ dot + popover text.

## Files
- `docs/design/tree-canvas/Tree Canvas.dc.html` — interactive prototype
- Depends on: `docs/design/theme/handoff.md` tokens
