# Handoff: Base Planner Panel (NMS Base & Resource Planner)

> Convention note: where this document and a later spec disagree, **the spec wins**.

## Overview
The build-checklist surface: one card per base, rolling the tree's leaf assignments up into concrete construction instructions — what to plant, build, and power, per base. Promotes the `Theme Variants.dc.html` 6a exploration to a full 3-base panel. **No "buy" language**: every line is something the player constructs.

## About the Design Files
`Base Planner.dc.html` is a **design reference created in HTML**, not production code. All quantities derive live from a small data model (crops/gases/minerals per 1 Stasis Device, sample yields/rates) so the interactions are real: device quantity scales every row, extractor class recomputes counts and fill times, the deficit button appends generators. Production computes the same rollup from the dependency graph shared with the tree canvas.

## Layout
- Header strip: target + quantity (Chakra Petch), mono aqua summary (`3 BASES · Σ kPs GEN · READY ~t`), Recompute (orange primary) / Share / "view tree →" link.
- Cards 340px wide, wrap row. Base identity = 3px `--base-*` frame + color chip + name (name is primary identity, SC 1.4.1).
- Sample bases match the tree's assignments: Verdant Moon (blue, crops), Gasworks (copper, gases + carbon), Cobalt Flats (purple, minerals).
- Unassigned bin: dashed `--border` panel; cleared leaves collect here with ⚠ (empty state shown; togglable via tweak).

## Card anatomy
1. **Header** — chip, name, rename affordance.
2. **Environment strip** — planet-type badge (glyph + caps label, monochrome on `--input-bg` per the method-badge rule: ❀ LUSH / ☣ TOXIC / ❄ FROZEN…), a short hazard note that feeds planning ("acid storms · hazard prot. req.", "blizzards at night · solar dips"), and the 12-glyph **portal address** (mono hex stand-in; production renders the glyph font) with a copy button (announced via aria-live).
2. **Sections** by producer type, `--panel-raised` rows:
   - FARM rows: `qty → plants (qty ÷ yield) → biodomes (plants ÷ 16)` + harvest time.
   - EXTRACTOR rows: count sized to fill within ~1.5h at current class + fill time + supply depots (720u) when qty > 360.
   - Section-level **class picker** (C/B/A/S, small 22px segmented, aqua selection) — one class per site, not per row: extractors at one hotspot share quality.
   - Byproduct rows (Condensed Carbon from gas refines) render as `--ok` "nothing to build" — demand met without construction.
3. **POWER** — GEN/DRAW meters on `--bg-canvas` tracks; overdraw segment `--danger`. Section header carries a **power type picker** (EM | SOLAR) and, for EM, a **CLASS picker** (C/B/A/S): EM output = base kPs × class multiplier (.5/1/1.5/2); solar is classless (fixed kPs/panel) and adds **1 battery per 2 panels** for night coverage. Switching type or downgrading class can reopen a deficit. Deficit is an action: `+ n × [EM generator|Solar Panel] (+n·out)` button appends to the build list and flips the block to `✓ headroom` (6a behavior); the headroom line states count, type/class, per-unit output, and batteries.
4. **BUILD footer** — the card's rollup: everything constructed; pending generators in `--danger` until the fix is clicked; `ready ~t` = longest producer in the card.

## Interactions (all live in the prototype)
- Card click/Enter = select (aqua ring **inboard** via overlay element, identity frame untouched; outfitter PR #180 rule).
- Extractor class picker → counts + fill times + power draw recompute.
- EM class picker → generator output, deficit/headroom, and fix-button sizing recompute.
- Power type picker (EM | SOLAR) → swaps generation math (solar: classless, + batteries), re-sizes the fix button, rewrites the BUILD rollup. One type per base in the mock; mixed grids deferred (see open questions). Cobalt Flats defaults to solar as the worked example.
- Deficit button → generators added, footer + header totals update.
- All recomputes announce via `aria-live="polite"`.

## Tweaks
- `deviceQty` 1–10: scales every quantity, plant count, extractor count, fill time.
- `emOutput` (kPs, default 110): base EM generator output at class B — swap in real game data without touching code.
- `solarOutput` (kPs, default 50): output per solar panel.
- `showTimes`: hides the time detail line (compact scanning mode).
- `showUnassignedBin`: toggles the bin.

## Sample-data notes
Yields (crops/plant), extractor rates (gas 200/h, mineral 250/h at B), EM output (110 kPs at B), solar output (50 kPs/panel, 1 battery per 2 panels), class multipliers (×.5/1/1.5/2 for extractors and EM generators alike), dome capacity 16, draws (dome 20, extractor 55, depot 10, base overhead) are **illustrative** — production reads game data. Resource lists per base are the real Stasis Device leaves from `docs/design/tree-canvas/handoff.md`.

## Open questions
1. Theme handoff Q1 (warn-yellow vs base-yellow) — the unassigned bin here uses ⚠ + text on gray, no yellow frame nearby; resolved for this surface, re-check when a yellow-framed base card carries a warning row.
2. Per-row class override (mixed-class sites)? Deferred — section-level picker holds until a user asks.
3. Mixed power grids (EM + solar at one base) — the mock is single-type per base; production likely needs a generator list instead of a type toggle.
3. "ready ~t" ignores refine time at the collector base; app-shell surface should decide where refining time is charged.

## Self-critique / WCAG 2.1 AA findings
- Deficit text `--danger` 3.82:1 on `--panel-raised` — always paired with ⚠ + stated kPs quantity + red meter segment; per theme handoff rule.
- Cards are clickable divs with `tabIndex` + focus outline; production should use a proper button/listbox semantic for selection.
- Time detail lines are 11.5px `--text-muted` mono on `--panel-raised` (4.17:1) — decorative reinforcement of the main line's counts; flagged per theme rule, revisit if times become sole info.

## Files
- `docs/design/base-planner/Base Planner.dc.html` — interactive prototype (v1: checklists, power, env strip, portal codes)
- `docs/design/base-planner/Base Planner v2.dc.html` — v2 manager view (see "v2 additions" below)
- Depends on: `docs/design/theme/handoff.md` tokens · leaf data from `docs/design/tree-canvas/handoff.md`
- Prior exploration: `Theme Variants.dc.html` 6a

## v2 additions (user-directed, form rounds 1–4)
- **Checkable BUILD TODO** per card: tick off built items (strike-through); the pending deficit item stays red and uncheckable until fixed via the POWER button. Header **progress bar** counts construction items + harvest-cycle elapsed (user choice: include harvest readiness). Footer: "n of m built · ready ~t".
- **Harvest-run route bar** above the cards: numbered base chips (identity color as 3px left edge) + travel method between legs (⌁ teleporter / ◇ portal), no timing (user choice).
- **Storage tracker**: stocked-vs-needed bar per resource row (user choice: per-row); full = `--ok`, partial = `--text-muted`.
- **Env strip v2**: biome badge + subtle biome tint (decorative, ≤.06 alpha), hazard note, SENT level · economy · star class as mono text (user choice: env strip, not own row), portal + copy.
- **Collapsible sections** with one-line summaries when closed; BUILD + POWER open by default (user choice). Production section (farm/extractors) collapsed.
- **Mini power-grid diagram** (gen → BUS → loads) renders in POWER of the **selected card only** (user choice).
- **Screenshot slot**: collapsible SCREENSHOT section with a drag-and-drop `<image-slot>` (placement decided by us after user skip — collapsed section keeps cards compact).
- **Notes**: quick tags (⚠ RESTOCK / ↻ REBUILD / ◈ VISIT) + free text (user choice: tags + text).
- v2 is data-driven (one card template over a bases array) — v1 stays as the simpler literal-markup reference.
- **Plan targets beyond industry** (user request): a TARGET switcher in the header swaps the whole plan — STASIS (industrial, 3 bases) or CAKE (cooking: Hexaberry Cake ×25/batch, 2 bases). The cooking plan adds two producer types: **RANCH** rows (fauna products — Wild Milk, Proto-Egg · grazing counts + pellet feeder) and a **KITCHEN** section (Nutrient Processor steps: ◇ process wheat→flour, milk→butter, batter, ⚑ final bake), with processors and the feeder as BUILD TODO items. The cake plan carries the `unverified` dashed chip (community recipe convention from the tree canvas). Method vocabulary grows to craft / refine / raw / **cook** — still no buy. Sections now collapse independently (RANCH vs KITCHEN).

## 8-bit restyle (v2 only, user request 2026-08-17)
- Silkscreen (pixel font) replaces Chakra Petch for the plan title, base names, and UNASSIGNED header (14px title / 10px card names — pixel fonts read small).
- All corner radii squared to 0; base cards + unassigned bin get a 2-step pixel-notch corner via clip-path (8px/4px stair).
- Meters and the header progress bar render as chunked pixel segments (repeating-linear-gradient, 5px on / 2px off) instead of smooth fills.
- Primary/secondary header buttons get a hard 3px offset shadow (no blur).
- Body/data type stays Space Grotesk / JetBrains Mono for legibility; v1 keeps the pre-8-bit look as reference.
- New sibling surface: `docs/design/bases-map/` — the Base Atlas (city-builder overview); linked from the header ("view atlas →").
