---
status: draft
date: 2026-08-29
implements: [ADR-0010, ADR-0004]
requires: [SPEC-0002, SPEC-0005, SPEC-0009]
---

# SPEC-0011: Shell Surface

## Graph Edges

- **Implements:** [ADR-0010](../../../adrs/ADR-0010-places-first-and-the-shell.md) — places authored first, bases-first entry, surfaces as view state, target search, and the hash/store split
- **Implements:** [ADR-0004](../../../adrs/ADR-0004-react-view-layer.md) — the React view layer this shell belongs to
- **Requires:** [SPEC-0005](../view-foundations/spec.md) — tokens, styling discipline, the no-arithmetic rule, state boundaries, module loading and the accessibility baseline, inherited rather than restated
- **Requires:** [SPEC-0009](../durable-store/spec.md) — the workspace and the place record whose `id` this spec makes load-bearing
- **Requires:** [SPEC-0002](../wasm-boundary/spec.md) — the module surface REQ "The Catalogue Crosses the Boundary" extends

Governing context that is not a frontmatter edge: [ADR-0008](../../../adrs/ADR-0008-durable-user-data-store.md) (the store the place record lives in), [ADR-0002](../../../adrs/ADR-0002-client-side-save-import.md) (save import as the second route to a place, not the only one), [SPEC-0007](../base-planner-card/spec.md) (the card this shell finally gives a route to, and whose scope note deferred this spec), [SPEC-0006](../tree-canvas/spec.md) (the canvas that produces assignments), [SPEC-0010](../base-atlas/spec.md) (a surface that already depends on this contract and states its half of it).

## Overview

The thing that holds the surfaces together: what a player sees first, how they move between views, how a place comes to exist, and which of the two state mechanisms owns what.

Realizes [ADR-0010](../../../adrs/ADR-0010-places-first-and-the-shell.md). SPEC-0007 deferred this in its own scope note — "application-shell furniture … belongs with the shell surface, which has no spec yet" — and the deferral is why `BasePlannerCard` renders only in a test fixture, why `<nav aria-label="Surfaces">` holds one inert button, and why the only way to load a plan is to already know an item id.

The load-bearing content is not navigation. It is the direction of the relationship between a base and a plan. ADR-0010 decided that a player authors places first and a plan assigns leaves to places that already exist, which turns `BaseID` from a key a plan invents into the identifier of a record that outlives every plan. Navigation follows from that; it does not motivate it.

Everything SPEC-0005 requires of a view surface, and everything SPEC-0009 requires of durable data, is inherited and not restated. This spec adds what is specific to the shell.

## Requirements

### Requirement: A Place Is Authored, and a Plan References It

A place MUST exist independently of any plan. `BaseID` MUST be the place record's `id` as [SPEC-0009](../durable-store/spec.md) REQ "A Place Is One Record Type, Whatever Its Kind" defines it — the same value, not a mapping onto it.

The application MUST NOT mint a second identifier for a place, and MUST NOT derive a place's identity from a plan's assignments. `Unassigned` remains the empty value and is not a place.

A plan MUST remain resolvable when it references no places at all; the result is a plan whose leaves are entirely unassigned, not an error.

#### Scenario: One identifier, not two

- **WHEN** a place is created and later assigned a leaf
- **THEN** the value the plan carries as `BaseID` is the place record's own `id`, and no other identifier for that place exists in the store

#### Scenario: A plan with no places still resolves

- **WHEN** a plan is resolved against a workspace holding no places
- **THEN** it resolves, and every leaf is reported unassigned rather than failing

### Requirement: An Assignment Naming an Absent Place Is Unassigned

Where a plan carries an assignment whose `BaseID` matches no place in the workspace, the leaf MUST be treated as unassigned and MUST be presented as such.

Deleting a place MUST NOT delete a plan, MUST NOT remove the leaves assigned to it, and MUST NOT leave an identifier rendered as a base with no name. The leaves MUST reappear in the unassigned group.

This rule MUST hold for every source of an assignment, including one decoded from a URL hash authored on another player's device.

#### Scenario: Deleting a place returns its leaves

- **WHEN** three leaves are assigned to a place and that place is deleted
- **THEN** the plan survives, the three leaves appear in the unassigned group, and no dangling identifier is rendered

#### Scenario: A shared plan naming unknown places

- **WHEN** a hash carrying assignments is decoded on a device whose workspace holds none of the named places
- **THEN** the plan renders with those leaves unassigned, and no error state is presented

### Requirement: The Shell Opens on Bases and Renders Without the Domain

The entry surface MUST be the bases surface.

The shell's entry render MUST NOT depend on the WASM module. Per [SPEC-0005](../view-foundations/spec.md) REQ "Module Loading" the module loads lazily after the shell is interactive, so the entry surface MUST be complete and operable with the module unavailable, unreachable, or still loading. It MUST NOT present a loading state in place of its content, and MUST NOT present module unavailability as an error on entry.

A player MUST be able to create a place, name it, and see it listed with the module never having loaded.

#### Scenario: Entry with no module

- **WHEN** the application is opened with the WASM module unavailable
- **THEN** the bases surface renders complete and interactive, with no error and no loading state standing in for its content

#### Scenario: Entry with an empty workspace

- **WHEN** the application is opened with no places stored
- **THEN** the bases surface presents an intentional empty state inviting the player to add a place, not a screen of zeroes

### Requirement: A Place Is Creatable by Hand

The bases surface MUST provide a route to create a place without a save file, independent of [SPEC-0008](../save-import/spec.md).

The minimum a place requires before a plan may assign to it is its generated `id` and a name. Every other field — kind, biome, hazards, sentinel and economy, portal address, screenshot, notes, and site configuration — MUST be optional at creation.

A place with no site configuration MUST be assignable. Its rollup MUST treat the site as unconfigured, and the card MUST render that absence as absence per [SPEC-0007](../base-planner-card/spec.md) REQ "Absent Data Is Absent" rather than as a zero.

#### Scenario: A name is enough

- **WHEN** a place is created with a name and nothing else
- **THEN** it persists across a reload and a plan can assign a leaf to it

#### Scenario: An unconfigured site is not a zero

- **WHEN** a leaf is assigned to a place that has no site configuration
- **THEN** the card presents the missing configuration as absent, and does not present it as a configured value of zero

### Requirement: Surfaces Are Shell View State

Surface selection MUST be view state the shell holds. The application MUST NOT introduce a router library.

The shell MUST expose exactly one `role="navigation"` landmark, named, containing the surface controls. Adding a surface MUST NOT add a second navigation landmark.

Cross-navigation between surfaces that is not part of the surface switcher — a card linking to the canvas, a run stop linking to a base — MUST be a content link inside `main`.

A surface MUST NOT be selectable before it can render; a surface whose data is unavailable MUST present its own empty or loading state rather than being absent from the switcher, so the set of surfaces does not change under the player.

#### Scenario: One landmark across every surface

- **WHEN** each surface in turn is selected
- **THEN** exactly one `role="navigation"` landmark exists in the document in every case, and it is named

#### Scenario: The switcher is stable

- **WHEN** the module is unavailable and a surface that needs it is offered
- **THEN** the surface remains listed and presents its own loading state when selected, rather than disappearing from the switcher

### Requirement: Target Selection Is a Search Over Known Items

The target control MUST be a search over known items. It MUST NOT be a field that accepts only an internal item id.

The search MUST match against both the item's display name and its id, MUST tolerate partial and inexact input, and MUST present the display name as the primary label with the id as secondary. A player MUST be able to reach any selectable item without knowing its id.

The searchable list MUST arrive through the module boundary. Per [SPEC-0005](../view-foundations/spec.md) REQ "Boundary Client" the view MUST NOT read the Tier 1 artifact directly, and it MUST NOT ship a compiled-in copy of the item list, which would drift from the artifact the module resolves against.

The control's visual form is the design's and is not specified here.

#### Scenario: Found by name

- **WHEN** a player types a partial display name
- **THEN** the matching item is offered, and selecting it sets the target without the id being typed

#### Scenario: The id still works

- **WHEN** a player types an exact item id
- **THEN** that item is offered

#### Scenario: No compiled-in list

- **WHEN** the view's sources are scanned
- **THEN** no item list literal is present, and the catalogue is reached only through the boundary client

### Requirement: The Catalogue Crosses the Boundary

The module MUST expose an entry point returning the searchable item catalogue: for each selectable item, its id and its display name.

The call MUST follow [SPEC-0002](../wasm-boundary/spec.md)'s envelope, error-code and contract-version rules exactly as `resolve`, `rollup` and `power` do. It MUST be subject to the same not-ready handling: a catalogue call made before the module has loaded MUST present a loading state, not a failure.

Adding this entry point is a change to the module's contract version.

#### Scenario: The catalogue is an ordinary boundary call

- **WHEN** the catalogue is requested before the module is ready
- **THEN** the view presents a loading state and retries once readiness resolves, rather than reporting an error

### Requirement: The Hash Owns the Plan, the Store Owns the Player

The URL hash MUST carry plan state only — target, quantity, method and recipe selections, and leaf assignments.

The durable store MUST own player-authored data — places and their annotations, ticked build items, and view preferences. No player-authored durable value may be encoded into the hash, and no hash-derived value may be written to the store as though the player authored it.

Ticked build items are per-place player data and MUST live in the store. `docs/design/README.md` line 37 lists them as hash content; that line predates [ADR-0008](../../../adrs/ADR-0008-durable-user-data-store.md) and does not govern.

Hash-derived state remains untrusted input under [SPEC-0005](../view-foundations/spec.md) § Security Requirements → Redirect Validation, and this spec adds no decoding path of its own.

#### Scenario: A share carries no player data

- **WHEN** a hash is encoded from a workspace with named places, notes and ticked items
- **THEN** the encoded value contains plan state only, with no place annotation, note or tick present

#### Scenario: A decoded hash authors nothing

- **WHEN** a hash carrying assignments is decoded
- **THEN** no place record is created or modified as a result

### Requirement: Signing In Is Not a Sync Trigger

Completing a sign-in MUST attach an owner to the workspace and MUST NOT transmit any place record by itself.

This restates the boundary [ADR-0008](../../../adrs/ADR-0008-durable-user-data-store.md) fixed and [ADR-0009](../../../adrs/ADR-0009-oidc-player-identity.md) §4 carried forward, because the shell is where sign-in is invoked and "authenticate, then reconcile" is the natural shape to build here.

#### Scenario: Authentication transmits nothing

- **WHEN** a player signs in with places stored and nothing marked shared
- **THEN** no place record is transmitted

## Security Requirements

This capability is part of a browser-rendered client application. It ships as static assets and a WASM module, with no server component and no HTTP endpoints of its own. There is no endpoint table in this spec because there are no endpoints; each topic below is recorded with its applicability so an uncovered topic is visible rather than absent.

### Authentication

The shell is where sign-in is invoked, but this capability defines no protected resource and gates no function on identity. Per [ADR-0008](../../../adrs/ADR-0008-durable-user-data-store.md) no account is required, ever, and REQ "Signing In Is Not a Sync Trigger" states the transmission boundary. The flow itself is [ADR-0009](../../../adrs/ADR-0009-oidc-player-identity.md)'s and is not specified here.

### Rate Limiting

The catalogue call is the only network-shaped operation this spec adds, and it is a call into a module already loaded in the page rather than a request. Per [SPEC-0005](../view-foundations/spec.md) § Rate Limiting the application MUST NOT introduce a call a user action can drive in an unbounded loop: the target search MUST NOT issue a catalogue call per keystroke.

### Security Headers

Owned by document delivery, not by this capability. This spec introduces no requirement for inline script or `eval` and MUST NOT weaken any policy set for the deployment. ADR-0009 anticipates widening `connect-src` for an identity provider; nothing in this spec requires it.

### Request Body Size Limits

Not applicable. This capability accepts no uploaded file. Save import is [SPEC-0008](../save-import/spec.md)'s, and its file-size refusal is stated there.

### CSRF Protection

Not applicable. There are no state-changing server routes; every edit is a local store write. Should the shell ever gain a server route, [SPEC-0005](../view-foundations/spec.md) § CSRF Protection requires that section be revisited before it ships.

### Redirect Validation

Plan state arrives in the URL hash and is untrusted input. [SPEC-0005](../view-foundations/spec.md) § Redirect Validation governs it and this capability inherits those rules, adding no redirect of its own. REQ "The Hash Owns the Plan, the Store Owns the Player" narrows the surface by forbidding player-authored data from the hash in either direction, and REQ "An Assignment Naming an Absent Place Is Unassigned" defines what a hash naming unknown places does.

Place names and notes are player-authored text and MUST be rendered as text. This capability MUST NOT introduce a path that renders any such value as markup, including in the surface switcher, the place list and the target search results.

## Accessibility Requirements

This spec involves user-facing UI. The following are MANDATORY per WCAG 2.1 AA, and add to [SPEC-0005](../view-foundations/spec.md)'s baseline — including its token contrast constraints — which is not restated here.

### WCAG 2.1 AA Compliance

All UI components produced by this spec MUST meet WCAG 2.1 Level AA conformance as the minimum accessibility target.

### ARIA Landmarks

The shell MUST expose exactly one `role="navigation"` landmark, and it MUST be named. This is the single landmark [SPEC-0010](../base-atlas/spec.md) § ARIA Landmarks and every other surface defer to; a surface MUST NOT add its own.

The shell MUST expose `role="banner"`, `role="main"` and `role="contentinfo"` per SPEC-0005 § ARIA Landmarks, and the selected surface MUST render inside `main`.

The currently selected surface MUST be identified programmatically, not by styling alone.

### Icon-Only Controls

Every icon-only control in the shell — surface switcher entries, the place-creation control, the target search's clear and submit affordances — MUST carry an `aria-label`. A glyph MUST NOT be the sole accessible name of anything.

### Dynamic Content Regions

Changing surface, creating a place, deleting a place, and selecting a target MUST be announced through an `aria-live="polite"` region naming what changed. Announcements MUST NOT be `assertive`: each is the expected result of the player's own action.

Deleting a place MUST announce the number of leaves returned to the unassigned group, so a player who cannot see the plan learns what the deletion did.

The target search's result count MUST be announced as it changes, so a player typing without sight of the list knows whether anything matched.

### Keyboard Navigation

Every operation in the shell MUST be reachable and operable by keyboard: switching surface, creating and naming a place, deleting a place, and searching for and selecting a target.

The target search MUST be operable as a combobox by keyboard alone — moving through results, selecting, and dismissing without selecting.

### Focus Management

Switching surface MUST move focus to the newly selected surface's region rather than leaving it on the switcher, and MUST NOT drop focus to the document body.

Creating a place MUST leave focus on the created place. Deleting a place MUST move focus to a documented, predictable destination rather than being lost.

#### Scenario: Focus follows a surface change

- **WHEN** a player switches surface using the keyboard
- **THEN** focus lands in the newly selected surface's region, and is not left on the switcher or lost to the body
