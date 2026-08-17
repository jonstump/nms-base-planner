# Handoff: NMS Base & Resource Planner

## Overview
A planning tool for No Man's Sky players: pick a target item (industrial product like a Stasis Device, or a cooking recipe like a cake), see its full crafting/refining/cooking dependency tree, assign leaf resources to player bases, and get per-base **build checklists** — what to plant, construct, and power at each base, with a harvest-run route across them. It is a build planner, not a shopping list: **there is no "buy" method anywhere** (craft / refine / raw / cook only), and power deficits are presented as actions ("+ 1 × EM generator"), not warnings.

## About the Design Files
Every file in this bundle is a **design reference created in HTML** — interactive prototypes showing intended look and behavior, not production code to copy directly. The task is to **recreate these designs in the target codebase's environment** using its established patterns and libraries — or, if no codebase exists yet, to pick an appropriate stack (the tree-canvas handoff recommends React with `@xyflow/react` + `elkjs`; the rest is ordinary component UI). The `.dc.html` files open directly in a browser (keep each folder's `support.js` and `image-slot.js` next to them); all interactions in them are real and worth clicking through before implementing.

Each surface has its own detailed `handoff.md` — **those are the specs**; this README is the map:
- `theme/handoff.md` — design tokens, type, control scale, accessibility math
- `tree-canvas/handoff.md` — dependency-tree surface (nodes, edges, method popover, a11y)
- `base-planner/handoff.md` — base cards, build todos, power, route bar, v1 vs v2, 8-bit restyle
- `bases-map/handoff.md` — Base Atlas overview map (districts, runs, building sprites)

## Changes since the first handoff zip
- **8-bit restyle** (v2 planner + atlas; spec in `base-planner/handoff.md` §"8-bit restyle"): Silkscreen pixel font for display text (≥8px caps), radius 0 everywhere, pixel-notch card corners via clip-path, chunked segment meters instead of smooth fills, hard 3px offset button shadows. v1 planner and token sheet keep the pre-8-bit look; Silkscreen joins the font set. Planner v2 card frames are now a padding-based colored wrapper + inner clip-path panel (continuous 3px border with notched corners on both edges).
- **TARGET switcher** in planner v2: STASIS (industrial, 3 bases) ↔ CAKE (cooking: Hexaberry Cake, 2 bases — RANCH fauna rows + KITCHEN Nutrient-Processor steps, `unverified` chip). Method vocabulary is craft / refine / raw / cook.
- **New surface: Base Atlas** (`bases-map/`).
- **Cross-navigation**: tree ↔ planner ↔ atlas header links ("view planner →" / "view atlas →" / "view tree →").

## Fidelity
**High-fidelity.** Colors, typography, spacing, and states are final and measured (contrast ratios and color-blind ΔE are computed live in `theme/Theme Tokens.dc.html`). Recreate pixel-perfectly with the codebase's component library. The **data is sample data**: yields, extractor rates, power draws, stock levels, biomes, and the Hexaberry Cake recipe are illustrative — production reads real game data (the Stasis Device tree structure itself is real, verified against community sources 2026-08; nodes flagged `unverified` carry that badge in the UI).

## Screens / Views
1. **Tree Canvas** (`tree-canvas/Tree Canvas.dc.html`) — left-to-right flowchart of the full dependency tree (34-node Stasis Device chain prototyped). Node cards 178px on #3c3836; leaf nodes framed 3px in their assigned base's color; method readable from badge AND edge style (refine inputs dashed). Click a node → method popover (segmented craft|refine, assign-to-base select on leaves). Production: React Flow custom nodes + elkjs layered layout.
2. **Base Atlas** (`bases-map/Bases Map.dc.html`) — city-builder overview: pixel-grid map, each base an 8-bit habitation-pod building in its identity color, dashed district territories (FARMLANDS, STASIS DISTRICT), traceable harvest-run routes (dotted paths, numbered waypoints, method chips) switched by a RUN toggle, side panel with base dossier or run leg list. See `bases-map/handoff.md`.
3. **Base Planner v2** (`base-planner/Base Planner v2.dc.html`) — the manager view, one card per base: tinted environment strip (biome, hazards, sentinel/economy/star, copyable portal address), collapsible producer sections with stocked-vs-needed bars, POWER block (EM|SOLAR type, C/B/A/S class, deficit-fix button, grid diagram on selected card), checkable BUILD TODO with progress bar, screenshot drop slot, tagged notes. Header TARGET switcher swaps the whole plan (STASIS ↔ CAKE) — the cake plan demonstrates RANCH (fauna products) and KITCHEN (Nutrient Processor steps) producer types. Harvest-run route bar above the cards.
4. **Base Planner v1** (`base-planner/Base Planner.dc.html`) — the simpler literal-markup reference for the card anatomy; superseded by v2 but kept because its markup is easier to read.
5. **Token sheet** (`theme/Theme Tokens.dc.html`) — living spec: every token with live-computed WCAG contrast and protan/deutan ΔE validation tables. Recreate tokens as CSS custom properties in the global stylesheet.
6. **Explorations** (`explorations/Theme Variants.dc.html`) — the decision record: scheme options 3a–3d/4a–4b (gruvbox classic 4a chosen), base-palette derivation 5a, and the 6a deficit→resolved card states. Reference only.

## Interactions & Behavior
Specified per surface in the three handoff.md files. Cross-cutting rules:
- **Borders carry identity only**: 3px base-color frames; hover = brightness(1.12), focus = 2px #8ec07c outline outboard, selection = 2px #8ec07c ring **inboard via overlay element** (never inset box-shadow — it paints under positioned children). Nothing else may write to a border.
- Every recompute (method/class/type change, deficit fix, todo check) announces via `aria-live="polite"`.
- Color is never the sole carrier: methods have glyph+text, bases have names, warnings have ⚠+text, deficits have stated kPs + red meter segment.
- Plan state (target, methods, assignments, todo checks) should serialize into a shareable URL hash; no localStorage.

## State Management
Per-base UI state (v2 prototype's `ui` map is the reference shape): power type + EM class, extractor class, added generators, section open/closed, todo done-map, note tags + text, selection. Plan-level: target, device/batch quantity. All quantities derive from the dependency graph — the prototypes' math (plants = qty÷yield, domes = plants÷16, extractors sized to ~1.5h fill, power gen = units × class-multiplied output) shows the intended rollup shape, not real constants.

## Design Tokens
Full set with measured contrast in `theme/handoff.md`. Core: bg #282828 / canvas #1d2021 / panel #32302f / raised #3c3836 / border #504945; text #ebdbb2, bright #fbf1c7, muted #a89984; interactive orange #fe8019 (only), ok/selection aqua #8ec07c, danger red #fb4934, warn yellow #d79921. Base identity palette (6): #fabd2f, #e6d9c0, #e8543a, #93b4d1, #a08f78, #b3618a. Type: Chakra Petch (display) / Space Grotesk (body) / JetBrains Mono + tabular-nums (all numerals). Spacing 4/8/12/16/24/32/48; radius 2px controls, 4px panels; controls 40px default, 30px small, 22px micro-segmented.

## Assets
No image assets — fonts load from Google Fonts (Silkscreen 400/700, Chakra Petch 600/700, Space Grotesk 400–600, JetBrains Mono 400–600). `base-planner/image-slot.js` is a prototype-only drag-and-drop placeholder; in production the screenshot slot is an ordinary image upload. Scanline/grid textures are CSS gradients (values in theme handoff). No game assets or trade dress are used or should be.

## Files
```
theme/          handoff.md · Theme Tokens.dc.html · support.js
tree-canvas/    handoff.md · Tree Canvas.dc.html · support.js
base-planner/   handoff.md · Base Planner.dc.html · Base Planner v2.dc.html · image-slot.js · support.js
bases-map/      handoff.md · Bases Map.dc.html · support.js
explorations/   Theme Variants.dc.html · support.js
```
`support.js` files are the prototype runtime — needed to open the `.dc.html` files, irrelevant to production.
