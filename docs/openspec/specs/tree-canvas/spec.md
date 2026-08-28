---
status: approved
date: 2026-08-19
implements: [ADR-0004, ADR-0005]
requires: [SPEC-0001, SPEC-0002, SPEC-0005]
---

# SPEC-0006: Tree Canvas

## Graph Edges

- **Implements:** [ADR-0004](../../../adrs/ADR-0004-react-view-layer.md) — the React view layer this surface is the first instance of
- **Implements:** [ADR-0005](../../../adrs/ADR-0005-multiple-recipes-per-output.md) — "the view surfaces the alternatives per node and the player may pick another"
- **Requires:** [SPEC-0001](../rollup-engine/spec.md) — node semantics, method and recipe resolution, provenance propagation
- **Requires:** [SPEC-0002](../wasm-boundary/spec.md) — the payload this surface renders and the plan it sends back
- **Requires:** [SPEC-0005](../view-foundations/spec.md) — tokens, styling discipline, the no-arithmetic rule, the boundary client, and state boundaries, all inherited rather than restated

## Overview

The dependency-tree surface: the player picks a target item and quantity and sees the full crafting and refining tree as a left-to-right flowchart, changes the method or recipe per node, and assigns leaf resources to bases.

This is the first surface built on SPEC-0005. Everything SPEC-0005 requires of a view surface applies here and is **not restated** — tokens, component styling, the prohibition on computing domain values, the single boundary client, and view-state boundaries are inherited. This spec adds only what is specific to the tree.

Two things this spec specifies have never been drawn. `docs/design/tree-canvas/handoff.md` and its prototype were authored on 2026-08-17, before ADR-0005 was accepted on 2026-08-18. The prototype's method popover offers a binary craft|refine choice; ADR-0005 requires the view to surface per-node **recipe** alternatives as well, of which one real item has 26 and another has 61. The prototype also predates the node's `yield` and `applications` fields. Where this spec requires a surface the design has not drawn, it says so and defers the visual form to the design rather than inventing it.

The design handoff's own convention note reads: where it and a later spec disagree, the spec wins.

## Requirements

### Requirement: Graph Rendering From the Boundary Payload

The canvas MUST render nodes and edges from a single `resolve` payload obtained through the SPEC-0005 boundary client. It MUST NOT assemble the graph from repeated boundary calls, and MUST NOT read the Tier 1 artifact.

Node order in the payload is the domain's, terminals first and target last, and SPEC-0002 REQ "Determinism Across the Boundary" guarantees it survives encoding. The canvas MUST take that order as given. It MUST NOT sort, rank, or otherwise reorder nodes, because deriving an order in the view would be a second place for it to drift from the domain's.

Each node's edges MUST be drawn from that node's own `children`. The canvas MUST NOT infer an edge that the payload does not contain.

#### Scenario: One crossing renders the whole tree

- **WHEN** the canvas renders a resolved plan of 36 nodes
- **THEN** exactly one `resolve` crossing produced it, and every node and edge was read from that single returned value

#### Scenario: The payload's order is the canvas's order

- **WHEN** the canvas holds a resolved payload
- **THEN** the node sequence it iterates matches the payload's sequence exactly, and no comparison function is applied to it

### Requirement: Layout Geometry Is Not a Domain Value

Node positions and edge paths MUST be computed by the layout engine from graph structure alone — which nodes exist and which edges connect them. Position MUST NOT be derived from any quantity, total, yield, application count, or producer figure.

This is not an exception to SPEC-0005 REQ "The View Computes No Domain Values". A coordinate is not a domain figure and the domain reports none; computing one is presentation. A layout that scaled a node by its total, or ordered a column by quantity, would be deriving a visual fact from a domain value and is prohibited.

#### Scenario: Layout reads structure, not quantities

- **WHEN** the layout engine is invoked for a resolved graph
- **THEN** its input is nodes and edges, and no node total, yield or application count is passed to it

#### Scenario: Changing quantity does not move the graph

- **WHEN** the target quantity changes and every total scales
- **THEN** node positions are unchanged, because no position was derived from a total

### Requirement: Node Card

A node card MUST show the item's display name, its total quantity, and its resolved method as a badge carrying both a glyph and a text label.

The card's border is reserved for one fact: **which base a leaf is assigned to**. A leaf assigned to a base MUST carry a 3px border in that base's colour token. An unassigned leaf MUST carry a 3px dashed border in the neutral border token **and** a warning dot, so the unassigned state is not conveyed by border style alone. A non-leaf node MUST carry a 1px neutral border.

No other state MUST write to the border. Hover MUST be expressed as a brightness filter, focus as an outboard outline, and selection as an inboard ring rendered as an overlay element. SPEC-0005 REQ "Component Styling Discipline" already forbids the inset box-shadow that would paint under positioned children; this requirement is the reason the border is unavailable to those states in the first place.

#### Scenario: Base identity owns the border

- **WHEN** a leaf node is assigned to a base and is simultaneously hovered, focused and selected
- **THEN** its border still shows the base's colour, and hover, focus and selection are shown by filter, outline and overlay ring respectively

#### Scenario: Unassigned is not colour alone

- **WHEN** a leaf node has no base assignment
- **THEN** it shows a dashed border and a warning dot, and the state is legible without colour perception

### Requirement: Method Selection

Clicking or pressing Enter on a node MUST open a control offering that node's methods. The options offered MUST be the node's `legalMethods` from the payload; the canvas MUST NOT compute which methods are legal.

A method that is not available for the node MUST be rendered and inert, with the reason stated, rather than hidden. A hidden option cannot be distinguished from one that does not exist.

The control MUST state the consequence of a change before it is made, in the domain's own terms.

#### Scenario: Legal methods come from the payload

- **WHEN** the method control opens for a node
- **THEN** the options shown are that node's `legalMethods`, and the canvas consulted no other source to determine them

#### Scenario: An unavailable method is visible and inert

- **WHEN** a node cannot be refined
- **THEN** the refine option is rendered, is not activatable, and states why

### Requirement: Recipe Selection

Where a node's payload carries more than one entry in `legalRecipes`, the canvas MUST offer the alternatives and MUST allow the player to select one. A node presenting a single route where the domain reports several is the failure ADR-0005 exists to prevent.

The selection surface MUST remain usable at the sizes the real data produces. The refiner tables carry 26 recipes for Sodium Nitrate and 61 for the largest cooked output, so a control whose legibility depends on a small fixed number of options MUST NOT be used.

Each alternative MUST be distinguishable by what it consumes and what it yields, since alternatives for one output differ in exactly those terms. A recipe identifier alone MUST NOT be the only thing distinguishing two options.

A node using its engine-default recipe MUST NOT record a selection in plan state, per SPEC-0002 REQ "Recipe Selection Crossing", so that only deliberate overrides reach the URL hash.

**The design has not drawn this control.** The prototype's segmented craft|refine control predates ADR-0005 and addresses method only. A surface implementing this requirement MUST carry the design's answer for the recipe control rather than extending the segmented control past the size it was drawn for.

#### Scenario: Alternatives are offered where they exist

- **WHEN** a node's payload reports 26 legal recipes
- **THEN** the canvas offers all 26 and the player may select any of them

#### Scenario: Alternatives are told apart by inputs and yield

- **WHEN** two recipes for one output are offered
- **THEN** each is shown with what it consumes and how many units it produces

#### Scenario: A default records nothing

- **WHEN** every node in a plan uses its default recipe
- **THEN** the plan state carries no recipe selections

### Requirement: Yield and Application Display

Where a node's resolved recipe has a yield other than 1, the canvas MUST make that yield visible on the node. A total of 300 reached through a recipe yielding 50 is a different build instruction from a total of 300 reached through a recipe yielding 1, and the node card as drawn shows only the total.

Where the canvas shows a node's `applications` count, it MUST render it under SPEC-0005 REQ "The View Computes No Domain Values". The domain reports applications exactly and unrounded, so this is the first surface at which a non-integer domain figure reaches a screen, and SPEC-0005's rule governs how it is set. The canvas MUST NOT round an application count to a whole number of crafting operations; SPEC-0001 confines rounding to enumerated physical boundaries and this is not one of them.

#### Scenario: A yield other than one is visible

- **WHEN** a node resolves to a recipe producing 50 units per application
- **THEN** the node shows that yield, and the total alone is not the only quantity displayed

#### Scenario: A fractional application count is not rounded

- **WHEN** a node's application count is an exact rational that is not an integer
- **THEN** it is displayed under SPEC-0005's display rule, and is not rounded up to a whole number of operations

### Requirement: Leaf Assignment to Bases

The canvas MUST allow a leaf node to be assigned to a base, and the assignment MUST be operable without a pointing device.

An assignment MUST be plan state carried as SPEC-0002 encodes it, not view-local state. Reassigning a leaf MUST cause the affected figures to be recomputed through the boundary; the canvas MUST NOT adjust any base's totals itself.

Assignment reaches the domain through stage 2, whose boundary entry point is reserved and not yet wired. A canvas implementing this requirement MUST NOT read the domain's rollup types directly to work around that; the dependency is on the entry point being wired.

#### Scenario: Assignment is keyboard-operable

- **WHEN** a player navigates to a leaf node and opens its control using only the keyboard
- **THEN** the base assignment can be changed and committed without a pointing device

#### Scenario: Reassignment recomputes through the boundary

- **WHEN** a leaf is moved from one base to another
- **THEN** the new figures come from a boundary call, and no base total was adjusted in the view

### Requirement: Provenance Display

A node whose payload reports it as not verified MUST carry a visible provenance marker stating that the data is community-sourced and not verified in-game.

The marker MUST be legible without alarm. Unverified data is the normal condition for parts of this dataset, not an error state, and MUST NOT be styled as one.

Provenance propagates: SPEC-0001 REQ "Provenance Propagation" marks a figure unverified when **any** contributing node is unverified, so the marker appears on every ancestor of an unverified node up to and including the target. A canvas implementing this requirement MUST remain legible when the marker is present on a connected span of the graph rather than on isolated nodes.

#### Scenario: The marker follows propagation

- **WHEN** a node deep in the tree is unverified
- **THEN** every node deriving a total from it, up to the target, also shows the marker

#### Scenario: Unverified is not an error state

- **WHEN** a node carries the provenance marker
- **THEN** it is not styled with the error or warning treatment reserved for conditions the player must resolve

### Requirement: Edge Rendering

An edge MUST carry the per-unit quantity relating its two nodes, taken from the payload.

The method of the node an edge feeds MUST be readable from the edge itself as well as from the node's badge, so the wiring reinforces the fact rather than the badge carrying it alone.

Edge styling MUST be decorative reinforcement only. Every fact an edge's appearance conveys MUST also be available as text on the node it connects to.

#### Scenario: Method is readable from the wiring

- **WHEN** a node's method is refine
- **THEN** the edges feeding it are visually distinguished from those feeding a crafted node

#### Scenario: No fact lives only in an edge

- **WHEN** edge styling is disregarded entirely
- **THEN** every fact it conveyed remains available as text on the connected nodes

## Security Requirements

This capability is a browser-rendered client application. It ships as static assets and a WASM module, has no server component, no accounts, no session, and no HTTP endpoints of its own — so several of the topics below have no surface in this spec rather than an unstated answer. Each is recorded with its applicability so an uncovered topic is visible rather than absent.

### Authentication

Not applicable. This capability defines no endpoints and no protected resources; there is nothing to authenticate to. Introducing any server-side surface to this capability would require this topic to be answered, not inherited.

### Rate Limiting

Not applicable. All computation is local, invoked by the player against their own machine. There is no shared resource to exhaust and no remote call to throttle.

### Security Headers

Deferred to the application shell, which owns document delivery. This capability contributes no headers and MUST NOT weaken any the shell sets — in particular, this spec introduces no requirement for inline script or `eval`, so a strict script CSP remains available to the shell.

### Request Body Size Limits

Not applicable to this capability. The canvas accepts no uploads. Save-file import is ADR-0002's surface; SPEC-0005 § Security Requirements → Request Body Size Limits already requires a maximum accepted size be enforced before a file is read into memory, and records the number itself as unchosen.

### CSRF Protection

Not applicable. There are no state-changing requests; plan changes are local recomputation through the WASM boundary, which is an in-process call and not a request.

### Redirect Validation

Plan state arrives in the URL hash, which is untrusted input. [SPEC-0005](../view-foundations/spec.md) § Security Requirements → Redirect Validation already governs this: URL-derived state is validated through the same decoding path as any other plan input, a hash that cannot be decoded produces an empty plan and a diagnostic rather than a partially-applied one, and the application MUST NOT navigate to a URL taken from decoded state. This capability inherits all three and adds no redirect of its own.

Item names and identifiers rendered by this capability come from the committed Tier 1 artifact rather than from player input, and MUST be rendered as text. This capability MUST NOT introduce a path that renders any payload field as markup.

## Accessibility Requirements

This spec involves user-facing UI. The following accessibility requirements are MANDATORY per WCAG 2.1 AA. They add to SPEC-0005's baseline, which already requires WCAG 2.1 AA conformance and the token contrast constraints, and are not restated here.

### WCAG 2.1 AA Compliance

All UI components produced by this spec MUST meet WCAG 2.1 Level AA conformance as the minimum accessibility target.

### ARIA Landmarks

The canvas region MUST be exposed as a landmark distinguishable from the surrounding application shell, so a screen-reader user can move to and past the graph without traversing every node.

### Icon-Only Controls

Every icon-only control MUST carry an `aria-label` describing its purpose. The method badge glyph MUST NOT be the sole accessible name of anything; it is accompanied by its text label.

### Dynamic Content Regions

A method change, recipe change, assignment change or quantity change MUST be announced through an `aria-live="polite"` region naming what changed and that totals updated. Announcements MUST NOT be `assertive`: a recompute is the expected result of the player's own action, not a critical status change.

### Keyboard Navigation

Each node MUST be a single tab stop, in the payload's node order — terminals first, target last — so that tab order follows the build order rather than the layout's visual arrangement.

Enter or Space MUST open a node's control. Escape MUST close it. All controls within it MUST be reachable and operable by keyboard, including the base assignment.

### Focus Management

The node control MUST trap focus while open, MUST move focus into itself on open, and MUST return focus to the node that opened it on close.

#### Scenario: Tab order is the domain's order

- **WHEN** a player tabs through the canvas from the first node
- **THEN** focus visits nodes in the payload's order, terminals first and target last

#### Scenario: Focus returns to its origin

- **WHEN** a node's control is opened and then dismissed with Escape
- **THEN** focus returns to that node

#### Scenario: A recompute is announced politely

- **WHEN** a method change causes totals to update
- **THEN** a polite live region announces the change and that totals updated
