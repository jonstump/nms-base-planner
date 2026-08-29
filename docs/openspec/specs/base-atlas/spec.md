---
status: draft
date: 2026-08-29
implements: [ADR-0015, ADR-0004]
requires: [SPEC-0005, SPEC-0009]
---

# SPEC-0010: Base Atlas

## Graph Edges

- **Implements:** [ADR-0015](../../../adrs/ADR-0015-base-atlas-coordinate-space-and-route-graph.md) — the Atlas as authored data rendered by the view, with no new boundary crossing
- **Implements:** [ADR-0004](../../../adrs/ADR-0004-react-view-layer.md) — the React view layer this surface belongs to
- **Requires:** [SPEC-0005](../view-foundations/spec.md) — tokens, styling discipline, the no-arithmetic rule, state boundaries and the accessibility baseline, inherited rather than restated
- **Requires:** [SPEC-0009](../durable-store/spec.md) — the workspace, the place record, `schemaVersion`, deletion, and eviction honesty that positions and runs live inside

Governing context that is not a frontmatter edge, because this spec depends on the decisions rather than on a spec realizing them: [ADR-0010](../../../adrs/ADR-0010-places-first-and-the-shell.md) (surfaces as shell view state, `BaseID` as the place `id`, hash-owns-the-plan), [ADR-0006](../../../adrs/ADR-0006-freighter-surface.md) (the freighter as a route node never positioned), [ADR-0008](../../../adrs/ADR-0008-durable-user-data-store.md) (the per-place sharing unit a position now travels inside). [SPEC-0006](../tree-canvas/spec.md) REQ "Layout Geometry Is Not a Domain Value" is precedent this spec follows and does not depend on.

Notably **absent**: SPEC-0001 and SPEC-0002. Every other view surface requires them. The Atlas makes no boundary call at all, and REQ "The Atlas Makes No Boundary Call" states that as a requirement rather than leaving it as an omission.

## Overview

The map of a player's base network: bases and other places drawn at positions the player arranged, grouped into districts, with harvest runs traced across them as ordered stops.

Realizes [ADR-0015](../../../adrs/ADR-0015-base-atlas-coordinate-space-and-route-graph.md). The design reference is `docs/design/bases-map/handoff.md` with the interactive prototype `docs/design/bases-map/Bases Map.dc.html`. The handoff marks its own figures illustrative, so no number in it is normative here.

Two things arrive with this surface that the project does not otherwise have. A **coordinate space**: places acquire positions that the player authors and the game never supplies. A **route graph**: a harvest run is an ordered sequence of stops with a travel method per leg. ADR-0015 decided both are authored data rendered by the view, and that no part of either crosses into the Go domain — not because rendering is the view's job, but because there is no distance to minimise. Atlas positions are arrangement, not geography, and teleporter travel is uniform-cost.

Everything SPEC-0005 requires of a view surface, and everything SPEC-0009 requires of durable data, is inherited and not restated. This spec adds what is specific to the Atlas.

**The shaping constraint.** The ordered list is canonical and the map renders it. This is stated first because it changes the component tree rather than decorating it: a surface designed map-first and made accessible afterwards is a different build than one designed list-first and drawn. REQ "The Ordered List Is Canonical" is the requirement; every other requirement in this spec is written to be satisfiable by the list alone.

## Requirements

### Requirement: Position Is Optional and Authored

A place's Atlas position MUST be a nullable field on the SPEC-0009 `PlaceRecord`. It MUST NOT be a separate record type, and it MUST NOT be a required property of a place.

A position MUST be two integers in the Atlas's own grid space, meaningful only relative to other positions in the same workspace. It MUST NOT be derived from, seeded from, or reconciled against `GalacticAddress` or the in-game `Position`, and no code path may assign one from save-file contents.

A place with no position is a first-class state, not an error and not a value awaiting a default. An unpositioned place MUST appear in the place list and MUST be available as a run stop; it MUST NOT appear on the map, and the application MUST NOT substitute an origin, a centre point, or any other placeholder coordinate for it.

#### Scenario: An unpositioned place is not a broken place

- **WHEN** a workspace holds a place that has never been positioned
- **THEN** the place appears in the place list, is selectable as a run stop, is absent from the map, and no error or empty-state warning is raised about it

#### Scenario: The save never supplies a position

- **WHEN** a place is created by save import from a save carrying `GalacticAddress` and `Position`
- **THEN** its Atlas position is null

### Requirement: A Freighter Is a Route Node Without a Position

A freighter MUST be representable as a run stop while carrying no position, per [ADR-0006](../../../adrs/ADR-0006-freighter-surface.md). The surface MUST NOT special-case the freighter to achieve this: it follows from position being optional, and any conditional on place kind in the positioning or map-rendering path is a defect.

The freighter MUST NOT be drawn on the map, MUST NOT be enclosed by a district rectangle, and MUST NOT contribute a point to any bounding box.

#### Scenario: The freighter rides the run and stays off the map

- **WHEN** an active run stops at a freighter between two positioned bases
- **THEN** the freighter appears in the run's ordered legs at its authored position in the sequence, and does not appear on the map

### Requirement: A District Is a Tag and Its Rectangle Is Derived

A district MUST be a name carried on a place. There MUST NOT be a district record, and a district's geometry MUST NOT be stored.

The dashed territory a district renders as MUST be the bounding box of its positioned members, computed in the view at render time. Because the rectangle is derived, moving a member MUST change the territory with no separate update, and no stored rectangle may exist to go stale.

A place with no district is a first-class state. It MUST be drawn on the map outside any territory, and MUST NOT be assigned a default district or an "ungrouped" pseudo-district record.

#### Scenario: The territory follows its members

- **WHEN** a member of a district is repositioned outside the current territory
- **THEN** the rendered rectangle encloses the new arrangement, with nothing written to the store beyond the moved place's position

#### Scenario: An ungrouped place is drawn

- **WHEN** a positioned place carries no district
- **THEN** it appears on the map outside every territory, and no district record was created for it

### Requirement: A Harvest Run Is Player-Authored

A harvest run MUST be a record in the SPEC-0009 workspace: an ordered list of stops, each stop naming a place, with a travel method recorded per leg.

A stop MUST reference a place by the SPEC-0009 place `id` — the same identifier ADR-0010 §1 makes `BaseID`. No second key may be minted for routing.

A run MUST belong to the workspace and MUST NOT belong to a plan. A run MAY record the plan that seeded it, for provenance. It MUST NOT be invalidated, reordered, or deleted when that plan changes or is deleted.

A run MUST NOT be derived from plan assignments. A plan carries a set of bases; a run carries a sequence and a per-leg method, neither of which a plan contains.

#### Scenario: A run outlives its plan

- **WHEN** the plan that seeded a run is edited to add, remove and reorder its base assignments, and is then deleted
- **THEN** the run's stops, their order, and their per-leg methods are unchanged

### Requirement: Seeding Is a One-Time Copy

A run MAY be seeded from a plan's base assignments. Seeding MUST produce an ordinary authored run and MUST NOT establish a binding: after seeding, no subsequent change to the plan may alter the run.

A seeded run MUST have its travel methods and its stop order set to values the player can see and change, rather than being left implicit or recomputed at render.

A seeded run's name MAY be taken from the plan's targets as a convenience, and MUST be editable.

#### Scenario: Seeding does not subscribe

- **WHEN** a run is seeded from a plan and the plan then gains a base
- **THEN** the run's stops are unchanged and no prompt reorders them

### Requirement: One Run Is Active at a Time

The Atlas MUST render at most one run at a time. Selecting a run MUST deselect the previously active one.

This constraint MUST hold in the rendering path rather than being enforced only in the run switcher: the map MUST NOT be capable of drawing two runs' waypoints simultaneously.

#### Scenario: Two runs sharing a stop cannot collide

- **WHEN** two runs both stop at the same place and one is activated
- **THEN** only the active run's waypoints are drawn, so no stop carries two waypoint markers

### Requirement: A Stop Naming a Deleted Place Is Retained and Unresolved

Deleting a place MUST NOT delete a run that stops at it, MUST NOT silently drop the stop, and MUST NOT renumber the waypoints around the gap.

The stop MUST be retained in place, in its original position in the sequence, and MUST be rendered as unresolved — visibly, with the unresolved state carried by more than colour. It MUST be removable by a deliberate player action, and its removal MUST then renumber the sequence as any other removal does.

#### Scenario: A deleted place leaves the route standing

- **WHEN** a place that is the third of five stops in a run is deleted
- **THEN** the run still exists, the third stop is present and marked unresolved, and the fourth and fifth stops are still numbered four and five

#### Scenario: Unresolved is not a colour

- **WHEN** the unresolved stop is rendered with every colour stripped from the document
- **THEN** its unresolved state is still stated

### Requirement: The Ordered List Is Canonical

The run panel's ordered legs and the place list MUST be present on the surface at all times, and MUST carry every operation the map carries. The map MUST be a rendering of that list.

The surface MUST NOT have a map-only operation. For every operation reachable by clicking, dragging, or otherwise pointing at a building, a waypoint, or a territory, an equivalent operation MUST be reachable from the list without a pointing device.

In particular, if a place can be repositioned by dragging, a non-spatial means of setting that place's position MUST exist. If a district can be drawn or resized spatially, a non-spatial means of setting district membership MUST exist.

#### Scenario: Every map operation has a list equivalent

- **WHEN** the surface's operations are enumerated
- **THEN** each operation reachable from the map is reachable from the list, and no operation exists that requires a pointer

#### Scenario: Position is settable without dragging

- **WHEN** a player using only a keyboard sets a place's Atlas position
- **THEN** the position is stored and the map reflects it

### Requirement: Run Identity Does Not Rest on Colour

The active run MUST be identifiable by its name. Order MUST be carried by the numbered waypoints and method MUST be carried by the per-leg chips, each with a text label. Run colour MUST be reinforcement only.

Per SPEC-0005's baseline, this is the existing rule that a glyph and a word accompany every colour, applied to a surface the design had leaning on hue.

#### Scenario: Identity survives colour removal

- **WHEN** the Atlas is rendered with every colour stripped from the document
- **THEN** the active run's name, the order of its stops, and each leg's travel method are all still stated

### Requirement: The Atlas Makes No Boundary Call

The Atlas MUST NOT call the WASM boundary. No position, route, district, distance, or travel entry point may appear on the bridge surface, and `internal/domain` MUST contain no position, distance, or route type.

The view MUST NOT compute a distance, a path length, a travel time, or an ordering of stops by any metric. Bounding-box geometry and waypoint placement are layout, permitted by SPEC-0006 REQ "Layout Geometry Is Not a Domain Value"; anything that would rank, optimise, or cost a route is not layout and is forbidden here.

This is stated as an absence rather than as a count of boundary calls, because ADR-0010 §5 adds a catalogue call for unrelated reasons and a fixed number would fail for a reason unconnected to this surface.

#### Scenario: The domain does not know the Atlas exists

- **WHEN** the Go domain and the boundary surface are searched for position, route, district or distance types and entry points
- **THEN** none exist

#### Scenario: The Atlas renders with the module absent

- **WHEN** the Atlas is rendered in a workspace with places, districts and a run, and the WASM module has not loaded
- **THEN** the surface renders completely, with no loading state and no deferred content

### Requirement: The Atlas Is a Surface in the Shell

The Atlas MUST be one of the shell's surfaces, selected by shell view state per ADR-0010 §4. It MUST NOT introduce a router, and MUST NOT introduce a second `role="navigation"` landmark.

Because the Atlas renders correctly with no domain call, it MUST NOT gate its own rendering on module readiness, and MUST NOT block the shell's entry render.

Cross-navigation from the Atlas to another surface — a run stop linking to a base's card, an "open planner" link — MUST be a content link inside `main`, not a navigation landmark.

#### Scenario: One navigation landmark

- **WHEN** the shell is rendered with the Atlas selected
- **THEN** exactly one `role="navigation"` landmark exists in the document

### Requirement: Positions and Runs Never Enter the Hash

The URL hash MUST carry plan state only. A hash encoded from a workspace holding positions, districts and runs MUST decode to plan state alone, with no position, no district, and no run present in the encoded value.

The Atlas MUST NOT read a position, a district, or a run from the hash, and MUST NOT accept one if present.

#### Scenario: A shared link carries no arrangement

- **WHEN** a hash is encoded from a workspace with positioned places, districts and two runs
- **THEN** the encoded value contains no position, district or run, and decoding it yields plan state only

### Requirement: Sharing a Place Discloses Its Arrangement

Because position is a field on `PlaceRecord`, the ADR-0008 per-place share carries it. The share confirmation MUST state that the place's Atlas position and district travel with it, before the share is created.

The share MUST NOT carry any run, because a run is a workspace record and not a place record.

#### Scenario: The player is told what leaves with the place

- **WHEN** a player shares a positioned place in a district
- **THEN** the confirmation names the position and district as included, and the resulting share contains no run

### Requirement: The Schema Change Fails Legibly

Adding position and district to `PlaceRecord`, and adding the run record, is a schema change under SPEC-0009. It MUST take a `schemaVersion` increment, and MUST inherit REQ "Versioned, and Fails Legibly": a workspace written at the previous version loads nothing and reports both versions, rather than loading places with positions omitted.

Positions and runs MUST inherit SPEC-0009 REQ "Storage Is Evictable and the Application Must Not Imply Otherwise". An arrangement the player spent time on MUST NOT be presented as permanent, and the surface MUST NOT describe it as saved in terms stronger than the store can honour.

#### Scenario: The bump is exercised, not assumed

- **WHEN** a workspace written at the previous `schemaVersion` is opened
- **THEN** nothing loads, and both the stored and the expected version are reported

## Security Requirements

This capability is part of a browser-rendered client application. It ships as static assets and a WASM module, with no server component and no HTTP endpoints of its own. There is no endpoint table in this spec because there are no endpoints; each topic below is recorded with its applicability so an uncovered topic is visible rather than absent.

### Authentication

Not applicable. This capability defines no endpoints and no protected resources. ADR-0009's player identity transmits no place record by itself, and nothing in this spec changes that.

### Rate Limiting

Not applicable. All rendering and all edits are local and player-invoked; there is no shared resource to exhaust.

### Security Headers

Deferred to the application shell, which owns document delivery. This capability contributes no headers, introduces no requirement for inline script or `eval`, and MUST NOT weaken any policy the shell sets.

### Request Body Size Limits

Not applicable. This capability accepts no uploaded file. A position is two integers and a run is a list of place ids and method values, all authored in-process. If a background image or map screenshot is ever added, [SPEC-0009](../durable-store/spec.md) REQ "Screenshots Are Local-Only" governs it and this spec adds nothing.

### CSRF Protection

Not applicable. There are no state-changing requests; every edit is a local store write.

### Redirect Validation

Plan state arrives in the URL hash, which is untrusted input. [SPEC-0005](../view-foundations/spec.md) § Security Requirements → Redirect Validation already governs it, and this capability inherits those rules and adds no redirect of its own. REQ "Positions and Runs Never Enter the Hash" narrows the surface further by forbidding this spec's data from the hash in either direction.

Place names, district names and run names are player-authored text and MUST be rendered as text. This capability MUST NOT introduce a path that renders any such value as markup, including in map labels, waypoint chips and territory captions.

## Accessibility Requirements

This spec involves user-facing UI, and it is the project's hardest accessibility case: a pixel map of clickable buildings. The following are MANDATORY per WCAG 2.1 AA, and add to SPEC-0005's baseline — including its token contrast constraints — which is not restated here.

REQ "The Ordered List Is Canonical" is the structural answer and is a functional requirement rather than an accessibility one, because it shapes the component tree. Everything below assumes it.

### WCAG 2.1 AA Compliance

All UI components produced by this spec MUST meet WCAG 2.1 Level AA conformance as the minimum accessibility target.

### ARIA Landmarks

The Atlas MUST expose the run panel and the place list as navigable regions, so a screen-reader user can move between the route and the places without traversing the map. The map itself MUST NOT be the only route to either.

The surface MUST NOT add a `role="navigation"` landmark; per ADR-0010 §4 the shell holds the only one.

### Icon-Only Controls

Every icon-only control — waypoint markers, travel-method chips, place-kind glyphs, district handles — MUST carry an `aria-label`. A glyph MUST NOT be the sole accessible name of anything; each is accompanied by its text label.

### Dynamic Content Regions

Activating a run, repositioning a place, changing a leg's travel method, and adding or removing a stop MUST be announced through an `aria-live="polite"` region naming what changed. Announcements MUST NOT be `assertive`: each is the expected result of the player's own action.

An operation that renumbers waypoints MUST announce the resulting count, so a player who cannot see the sequence learns the route length changed.

### Keyboard Navigation

Every operation on this surface MUST be reachable and operable by keyboard, per REQ "The Ordered List Is Canonical". This includes setting a position, assigning a district, ordering stops, setting a leg's method, activating a run, and removing an unresolved stop.

The map MUST NOT be a keyboard trap, and MUST be skippable in a single tab stop.

### Focus Management

Focus MUST remain stable across a re-render: reordering a run MUST leave focus on the moved stop, and repositioning a place MUST leave focus on the control that moved it.

Where an operation removes the focused element — deleting a stop, or deleting a place a stop names — focus MUST move to a documented, predictable destination rather than being lost to the document body.

#### Scenario: Focus follows the moved stop

- **WHEN** a stop is moved from position four to position two using the keyboard
- **THEN** focus remains on that stop, and a polite live region states its new position

#### Scenario: The map is skippable

- **WHEN** a keyboard user tabs through the surface
- **THEN** the map is passed in a single tab stop and the run panel and place list are reached without entering it
