# Handoff: Base Atlas (NMS Base & Resource Planner)

> Convention note: where this document and a later spec disagree, **the spec wins**.

## Overview
City-builder-style overview of all bases and base groups: a pixel-grid map with each base as a small 8-bit building, dashed **district** territories grouping nearby bases, and traceable **harvest-run** routes (dotted pixel paths with numbered waypoints and travel-method labels). A side panel shows the selected base's dossier or the active run's leg list. Companion to the per-base planner (`../base-planner/`) — this is the "where", the planner is the "what to build".

## About the Design Files
`Bases Map.dc.html` is a design reference in HTML, not production code. Coordinates are hand-placed sample data; production lays bases out from stored positions (player-arranged, drag to move — not prototyped).

## Layout
- Header: BASE ATLAS (Silkscreen pixel font, 15px) + counts line; RUN segmented toggle (STASIS RUN / CAKE RUN); links to planner + tree.
- Map: 940×560 `--bg-canvas` with 32px pixel grid (1px lines at .035 alpha).
- Districts: dashed 2px `--border` rectangles, ≤.05 alpha tint, Silkscreen 8px name tab at top-left. Togglable (tweak).
- Buildings: habitation-pod pixel structures — stepped dome cap in the base's identity color (ribbed: 2px seam pixels, two brightness steps), light rim + body band (`#d5c4a1`/`#bdae93`) with a repeating dark window strip, darker skirt, antenna — with a mono label chip (glyph + name) beneath. Base identity color lives in the dome only. Click/Enter selects (aqua outline).
- Routes: active run only. Dotted 4px pixel path (repeating-gradient dashes in run color: STASIS aqua, CAKE yellow), method chips mid-leg, 16px numbered waypoint squares at each stop.
- Side panel: base dossier (biome/hazard, power, todo, district, runs, portal + copy) or run panel (ordered stops with methods, Σ gen, ready) when no base is selected. Both link to the planner.

## 8-bit conventions (shared with planner v2 restyle)
Silkscreen for display text only (≥8px, short caps strings); JetBrains Mono/Space Grotesk for data and body. Radius 0 everywhere. Chunked/dashed fills instead of smooth. Hard offset shadows, no blur.

## Sample data
5 bases (the 4 from the planner plans + 1 ungrouped outpost), 2 districts (FARMLANDS, STASIS DISTRICT), 2 runs matching the planner's targets. Power/todo figures echo the planner's sample state.

## Open questions
1. Base drag-repositioning and district drawing are production features — not prototyped.
2. Should selecting a run stop here deep-link to that card in the planner? Link currently goes to the planner top.
3. Verdant Moon is in both runs — waypoint "1" chips overlap identically by design; revisit if runs can share mid-route stops.

## Files
- `docs/design/bases-map/Bases Map.dc.html` — interactive prototype
- Depends on: theme tokens (`../theme/handoff.md`), planner sample state (`../base-planner/handoff.md`)
