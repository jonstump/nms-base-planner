# Handoff: Theme + Tokens (NMS Base & Resource Planner) — Gruvbox

> Convention note: where this document and a later spec disagree, **the spec wins** — record deviations at the top of this file when integrating.
> **Deviation from the design brief, by user decision:** the brief's stated direction was deep-space navy + coral + teal. Four schemes were prototyped (`Theme Variants.dc.html`, options 3a–3d) plus two gruvbox riffs (4a, 4b); the user selected **gruvbox classic (4a)**. The retro-sci-fi rules (texture, geometric type, mono numerals, border discipline) carry over unchanged.

## Overview
Token set for the planner in gruvbox dark. Dark retro-terminal theme: bg0 surfaces, cream text, orange interactive, aqua ok/selection, red deficit. No game assets, fonts, or trade dress.

## About the Design Files
`Theme Tokens.dc.html` is a **design reference created in HTML** — a living spec sheet, not production code. Its validation tables are **computed live at render time** from the token hexes (WCAG 2.1 contrast; Machado 2009 protanopia/deuteranopia simulation → CIELAB ΔE76), so the page cannot drift from its own math. Recreate as CSS custom properties in the build repo's global stylesheet.

## Tokens

### Backgrounds & chrome (gruvbox canon values)
- `--bg` #282828 (bg0) · app background
- `--bg-canvas` #1d2021 (bg0_h) · tree canvas + meter tracks
- `--panel` #32302f (bg0_s) · panels, base cards
- `--panel-raised` #3c3836 (bg1) · rows/cards on panels
- `--input-bg` #45403d · fields, segmented controls
- `--border` #504945 (bg2) · default 1px border
- `--border-soft` #453f3c · quiet borders
- `--divider` #3a3634 · hairlines

### Text (measured vs #282828 / #32302f / #3c3836)
- `--text` #ebdbb2 (fg1) · 10.75 / 9.57 / 8.45
- `--text-bright` #fbf1c7 (fg0) · headings, values · 12.99+
- `--text-muted` #a89984 (gray) · 5.30 / 4.72 / **4.17** — on `--panel-raised` restrict to ≥17px or switch to `--text`
- `--text-dim` #7c6f64 (bg4) · 3.03 / 2.70 / 2.38 — **decorative ≥18px only**, never unique info

### Accent & state
- `--accent` #fe8019 (bright orange) · interactive ONLY · 5.20:1 on `--panel`; dark text #1d2021 on orange buttons = 6.49:1
- `--accent-hover` #ffa347 · `--accent-border` #af3a03
- `--danger` #fb4934 (bright red) · deficit/destructive · 3.82:1 on `--panel` (non-text ✓; as text always ≥15px w/ glyph)
- `--ok` #8ec07c (bright aqua) · ok, links, selection ring · 6.24:1
- `--ok-dim` #689d6a
- `--warn` #d79921 (neutral yellow) · unassigned warnings · 5.29:1
- Deviation from the navy scheme's rule: gruvbox has a real red, so deficit gets `--danger` and orange stays purely interactive — cleaner than one color doing both.

### Base accent palette (categorical, 6)
3px identity frames; **nothing else may write to a border** (the-outfitter #132). Hover = brightness(1.12), focus = 2px `--ok` outline outboard, selection = 2px `--ok` ring inboard.
- `--base-1` yellow #fabd2f · `--base-2` sand #e6d9c0 · `--base-3` copper #e8543a · `--base-4` blue #93b4d1 · `--base-5` gray #a08f78 · `--base-6` purple #b3618a

**Validation (measured; live on the prototype)** against the three frame surfaces #1d2021 / #282828 / #32302f:
- Contrast: yellow 9.67/8.69/7.74 · sand 11.75/10.57/9.41 · copper 4.50/4.04/3.60 · blue 7.57/6.80/6.06 · gray 5.23/4.70/4.19 · purple 3.90/3.51/3.12. All ≥3:1 (SC 1.4.11); purple is the floor at 3.12.
- CB distinguishability: min pairwise ΔE76 under protan/deutan sim — floor is **gray×purple at 21**; all other pairs ≥23, most ≥31. Gruvbox's lighter backgrounds compress the usable gamut (every palette color must stay light enough for 3:1), so the navy scheme's ΔE-24 floor is not reachable; ΔE 21 is above the flag threshold (20).
- **Canon colors deliberately excluded:** bright green #b8bb26 collapses into yellow under deuteranopia (ΔE 5 — the classic gruvbox CB trap); orange and red are spent on interactive/danger. Sand and gray fill those slots.
- Base name remains the primary identity everywhere (SC 1.4.1); color reinforces.

### Type
- Display: **Chakra Petch** 600/700 · headers, panel titles, rollup figure · floor 13px
- Body/UI: **Space Grotesk** 400/500/600
- Numerals & labels: **JetBrains Mono** + `font-variant-numeric: tabular-nums` · every quantity, time, kPs figure, micro-label
- Scale: 11.5 label (mono, ls .12em, caps) / 13 meta / 15 body / 17 emphasis / 20 h3 / 26 h2 / 34 display

### Spacing, radius, control scale
- Spacing 4/8/12/16/24/32/48 · radius 2px controls, 4px panels
- One control scale (outfitter #134 discipline): default 40px = 10+10+18+2, 15px font · small 30px = 6+6+16+2, 13px font. Rows never mix steps; coarse pointers grow square targets to 44px.

### Texture (decorative only)
- Scanline `repeating-linear-gradient(0deg, rgba(251,241,199,.018) 0 1px, transparent 1px 3px)` on `--bg`
- 24px grid `rgba(235,219,178,.04)` on `--bg-canvas`

## Decisions
- Method badges (craft/refine/raw — no buy: this is a build planner, not a shopping list) stay **monochrome** — glyph + mono label on `--input-bg`; refine reinforced by dashed edges on canvas. Node cards already carry base-identity frames.
- Selected base card: aqua ring drawn **inboard** via pseudo-element (never an inset box-shadow — it paints under positioned children; outfitter PR #180 lesson), identity frame untouched.
- Deficit fix is an action, not a warning: "+ 1 × EM generator (+110)" is a button that appends to the base's build list (prototyped in `Theme Variants.dc.html` 6a).

## Open questions
1. `--warn` #d79921 vs `--base-1` yellow #fabd2f: a yellow-framed base with an unassigned warning shows two nearby yellows. Mitigation: warnings always carry ⚠ + text, never color alone. Revisit at the base-planner surface review.
2. `--input-bg` #45403d sits close to `--border` #504945; if fields read as borderless, drop input-bg to #3c3836 and give fields a 1px #504945 border.

## Self-critique / WCAG 2.1 AA findings
- `--text-muted` fails 4.5:1 on `--panel-raised` (4.17) — rule added above (≥17px or `--text` there).
- `--danger` as text is 3.82:1 on `--panel` — deficit lines render ≥15px with the ⚠ glyph and a stated quantity, and the meter overdraw segment repeats the fact non-textually; acceptable, flagged.
- Focus: 2px #8ec07c outline at 2px offset, visible on all surfaces (6.24:1+).

## Files
- `docs/design/theme/Theme Tokens.dc.html` — living token sheet (live math; CB-sim tweak included)
- `Theme Variants.dc.html` — scheme exploration (3a–3d, 4a–4b), palette derivation (5a), Base C hi-fi card (6a)
- Convention source: jonstump/the-outfitter `client/src/styles/global.css`, `docs/design/hunter-loadout-lists/handoff.md`
