---
status: draft
date: 2026-08-20
implements: [ADR-0004]
requires: [SPEC-0001, SPEC-0002, SPEC-0005]
---

# SPEC-0007: Base Planner Card

## Graph Edges

- **Implements:** [ADR-0004](../../../adrs/ADR-0004-react-view-layer.md) — the React view layer this surface belongs to
- **Requires:** [SPEC-0001](../rollup-engine/spec.md) — producer rollup and power computation, stages 2 and 3
- **Requires:** [SPEC-0002](../wasm-boundary/spec.md) — the payloads this card renders and the configuration it sends back
- **Requires:** [SPEC-0005](../view-foundations/spec.md) — tokens, styling discipline, the no-arithmetic rule, the boundary client, and state boundaries, inherited rather than restated

## Overview

One card per base, turning the tree's leaf assignments into construction instructions: what to plant, extract, ranch, cook, build and power at that base.

This spec covers **the card**. The panel that arranges cards — the header strip, the harvest-run route bar, the target switcher, the unassigned bin, and the link to the base atlas — is application-shell furniture and belongs with the shell surface, which has no spec yet. Where the card needs something from that chrome, this spec names the dependency rather than absorbing the chrome.

Everything SPEC-0005 requires of a view surface is inherited and not restated. This spec adds what is specific to the card.

The design references are `docs/design/base-planner/handoff.md` with two prototypes: v1, the checklist/power/environment reference, and v2, a manager view adding a checkable build list, storage tracking, notes, a screenshot slot, collapsible sections and an 8-bit restyle. The handoff marks its own quantities illustrative — "production reads game data" — so no numeric value in it is treated here as normative.

Three things this card displays have no source in anything built or specified: base identity metadata, durable per-base user data, and provenance on producer figures. Each is specified below as a constraint on what the card may do without them, rather than as a feature waiting on them.

## Requirements

### Requirement: Card Composition From the Build Payload

Each card MUST be composed from the stage 2 and stage 3 payloads for its base, obtained through the SPEC-0005 boundary client. The card MUST NOT aggregate, total, or reconcile figures across bases, and MUST NOT derive one base's figures from another's.

Where a figure the card displays is a count the domain reports — plants, biodomes, extractors, depots, fauna, nutrient processors, pellet feeders, additional generators, batteries — the card MUST render the domain's value. It MUST NOT compute a count from a quantity and a rate, even where both are present in the payload.

Counts the domain reports per base MUST NOT be re-derived per row. Nutrient processors and pellet feeders are base-level figures; summing per-row values would overcount whenever a base carries more than one step or more than one fed fauna row.

#### Scenario: Every count is the domain's

- **WHEN** a card renders a farm row showing plants and biodomes
- **THEN** both numbers came from the payload, and neither was computed in the view from a quantity and a yield

#### Scenario: Base-level counts stay base-level

- **WHEN** a base carries three kitchen steps
- **THEN** the card shows the base's reported nutrient processor count once, and does not sum a per-step figure

### Requirement: Base Identity and Selection

A card MUST identify its base by name as the primary identifier, with the base's colour as reinforcement rather than as the sole carrier of identity.

The card's frame is reserved for base identity. Selection MUST be rendered as an inboard ring using an overlay element, leaving the identity frame intact — SPEC-0005 REQ "Component Styling Discipline" already forbids the inset box-shadow this rules out.

A card MUST be selectable using a control with the correct semantics for a selection, operable by keyboard. A generic element given a tab index MUST NOT be used.

#### Scenario: Identity survives selection

- **WHEN** a card is selected
- **THEN** its base-colour frame is unchanged and the selection is shown by an inboard ring

#### Scenario: Colour is not the only identity

- **WHEN** base colours are not perceivable
- **THEN** each card remains identifiable by its name

### Requirement: Producer Sections

A card MUST present its construction rows grouped by producer type, covering every producer type the payload reports for that base: farm, extractor, ranch and kitchen.

Each row MUST state what is built and how much is required. A row MUST NOT present only the required quantity, since the quantity is the demand and the count is the instruction.

Where the payload reports a range rather than a single value — a crop's yield per plant is a range, and counts are sized on its pessimistic bound — the card MUST NOT present the optimistic bound as the planning figure.

#### Scenario: Every reported producer type appears

- **WHEN** a base's payload carries farm, extractor, ranch and kitchen rows
- **THEN** the card presents all four groups

#### Scenario: The instruction is shown, not just the demand

- **WHEN** a farm row requires a quantity of a crop
- **THEN** the card shows the plants and biodomes to build, not the required quantity alone

### Requirement: Site Configuration

A card MUST expose the site's extractor class as a per-site control, not a per-row one. Extractors at one base share a hotspot, so a per-row class would express a configuration the domain does not model.

A card MUST expose the site's fill duration, since extractor counts are sized to it and a count shown without the patience it assumes is not interpretable.

Changing either MUST recompute through the boundary. The card MUST NOT adjust counts, fill times or power draw itself.

#### Scenario: Class is a site control

- **WHEN** a base has three extractor rows
- **THEN** one class control governs all three, and no row carries its own

#### Scenario: Reconfiguration recomputes through the domain

- **WHEN** the extractor class changes
- **THEN** new counts, fill times and draw figures come from a boundary call

### Requirement: Byproducts Are Shown, Not Omitted

Where the payload reports an item's demand as covered by another producer's byproduct at the same base, the card MUST show that item with its demand and what covers it, marked as requiring no construction.

Such an item MUST NOT be omitted from the card. An absent row is indistinguishable from an overlooked requirement, and the fact that a demand is already met is a planning result rather than the absence of one.

#### Scenario: A covered demand is visible

- **WHEN** condensed carbon demand at a base is covered by a gas refine's byproduct
- **THEN** the card shows the item, its demand, and the producer covering it, marked as needing nothing built

### Requirement: Power Position

A card MUST show its base's generation and draw, and MUST make the relationship between them legible — whether the base is in surplus or deficit, and by how much.

Generation, draw and the resulting balance MUST be rendered from the payload's exact values under SPEC-0005 REQ "The View Computes No Domain Values". The card MUST NOT compute a balance, a percentage, or a meter proportion from the two figures as displayed; where a proportional indicator is drawn, it is presentation of values the domain reported, and any numeric figure shown alongside it MUST be the domain's.

A deficit MUST be conveyed by more than colour, carrying a symbol and the shortfall as a stated quantity.

#### Scenario: The balance is the domain's

- **WHEN** a card shows a base in deficit
- **THEN** the shortfall figure came from the payload and was not computed in the view

#### Scenario: Deficit is not colour alone

- **WHEN** a base is in deficit
- **THEN** the state carries a symbol and the shortfall as text alongside any colour treatment

### Requirement: Power Configuration Supports Mixed Sources

A card MUST allow a base's electromagnetic generator count, its generator class, and its solar panel count to be configured independently. The domain models all three as separate values on one base, so a control admitting only one source type at a time cannot express a configuration the domain accepts.

Solar MUST NOT be presented as carrying a class. The domain's solar output is classless, and offering a class control for it would imply a computation the domain does not perform.

Where solar panels are configured, the card MUST show the batteries the domain reports for night coverage.

#### Scenario: A base runs both sources

- **WHEN** a base is configured with electromagnetic generators and solar panels together
- **THEN** the card accepts the configuration and shows the resulting generation

#### Scenario: Solar carries no class

- **WHEN** the solar panel count is configured
- **THEN** no class control is offered for it

### Requirement: Deficit Is an Action, Including When It Cannot Be Sized

Where the payload reports additional generators that would clear a deficit, the card MUST present that fix as an action stating the count, the unit type, and the resulting position, rather than as a warning to interpret.

Where the payload reports that the fix cannot be sized because no generator class is configured, the card MUST still present the deficit and MUST state that the fix needs a class before it can be costed. It MUST NOT hide the deficit, and MUST NOT present an unsized fix as an actionable count.

The card MUST NOT size a fix the domain did not report. Where a deficit exists at a base whose generation is solar, and the payload reports no sized fix, the card MUST NOT compute a panel count of its own.

#### Scenario: A sized fix is an action

- **WHEN** the payload reports additional generators clearing a deficit
- **THEN** the card offers an action naming the count and type, and states the position it produces

#### Scenario: An unsized fix is still a visible deficit

- **WHEN** a base is in deficit and no generator class is configured
- **THEN** the deficit is shown, and the fix is stated as needing a class rather than offered as a count

#### Scenario: No fix is invented

- **WHEN** a solar base is in deficit and the payload reports no sized fix
- **THEN** the card offers no computed panel count

### Requirement: Build Rollup Footer

A card MUST carry a rollup of everything to be constructed at that base, drawn from the same payload as the sections above it.

Items pending because of an unresolved deficit MUST be distinguished from items that are simply not yet built.

The card MUST NOT present a completion figure it cannot source. A count of built versus total requires durable per-base state this project does not yet have, and a footer showing a fraction of items complete MUST NOT be rendered against state the card invented for the session.

#### Scenario: The footer agrees with the sections

- **WHEN** the footer lists constructed items
- **THEN** every item corresponds to a row in the card's sections, and no item was added by the footer

#### Scenario: A pending deficit is distinguishable

- **WHEN** a base has an unresolved power deficit
- **THEN** the generators it implies are shown as pending, distinct from unbuilt items

### Requirement: Duration Display

Where the card shows a duration — a fill time, a growth time, a collection cycle, a processing step, or a base's readiness estimate — it MUST present it as an estimate rather than as a precise figure.

The domain's own rate constants do not state their time unit; the artifact does not record it, and the engine's arithmetic is consistent under either reading while its absolute durations are not. This card is the first surface at which those durations become visible to a player, so it MUST NOT present them with a precision the underlying data does not support.

The card MUST NOT convert a duration into a different unit by arithmetic of its own. Where a duration is displayed in a unit other than the payload's, the conversion is a domain concern.

#### Scenario: A duration reads as an estimate

- **WHEN** a card shows an extractor fill time
- **THEN** it is presented as an estimate, not as an exact figure

#### Scenario: No unit conversion in the view

- **WHEN** a duration crosses the boundary in one unit and is displayed in another
- **THEN** the converted value came from the domain, not from arithmetic in the card

### Requirement: Provenance on Displayed Figures

Where a figure the card displays is reported as not verified, the card MUST mark it, using the same treatment as elsewhere in the view and without styling it as an error.

Several of this card's figures rest on constants that are planner policy or community-sourced rather than read from the game tables. Where the payload reports provenance for such a figure, the card MUST surface it. Where the payload reports no provenance for a figure whose derivation includes such a constant, the card MUST NOT present that figure as verified by displaying it unmarked alongside marked ones in a way that implies the distinction was checked.

#### Scenario: An unverified figure is marked

- **WHEN** the payload reports a base's power budget as not verified
- **THEN** the card marks it, and does not style it as an error condition

### Requirement: Absent Data Is Absent

A card MUST render completely and correctly using only the plan payloads and the base identifier.

Base environment and location details — planet type, biome, hazards, sentinel level, economy, star class, and portal address — have no source in the Tier 1 artifact, the domain, or any accepted specification. The card MUST NOT display placeholder, sample, or invented values for any of them. Where such a detail is not available, the card MUST omit it rather than showing a stand-in.

Durable per-base user data — construction items ticked off, stocked quantities, notes, tags, screenshots, and player-assigned base names — is neither plan state nor the interface state SPEC-0005 REQ "View State Boundaries" permits the view to hold. The card MUST NOT persist such data, and MUST NOT present a control implying persistence, until a governing decision establishes where it lives.

#### Scenario: Missing metadata is omitted, not faked

- **WHEN** no environment data is available for a base
- **THEN** the card renders without the environment details and shows no placeholder values

#### Scenario: No control implies unavailable persistence

- **WHEN** the card is rendered
- **THEN** it offers no control whose effect would be to persist per-base user data, since no store for it exists

## Security Requirements

This capability is part of a browser-rendered client application. It ships as static assets and a WASM module, with no server component, no accounts, and no HTTP endpoints of its own. Each topic below is recorded with its applicability so an uncovered topic is visible rather than absent.

### Authentication

Not applicable. This capability defines no endpoints and no protected resources.

### Rate Limiting

Not applicable. All computation is local and player-invoked; there is no shared resource to exhaust.

### Security Headers

Deferred to the application shell, which owns document delivery. This capability contributes no headers, introduces no requirement for inline script or `eval`, and MUST NOT weaken any policy the shell sets.

### Request Body Size Limits

Applicable if and only if the screenshot slot is built. An image accepted by drag-and-drop is untrusted input from the player's disk, and a size limit MUST be enforced before the file is read into memory, with an over-limit file refused rather than partially processed — the same discipline SPEC-0005 requires of save-file import. REQ "Absent Data Is Absent" defers the feature until a store exists; this requirement governs it when it arrives.

An accepted image MUST NOT be rendered by interpreting its contents as markup, and MUST NOT be carried in plan state or the URL hash.

### CSRF Protection

Not applicable. There are no state-changing requests; recomputation is an in-process call across the WASM boundary.

### Redirect Validation

Plan state arrives in the URL hash, which is untrusted input. [SPEC-0005](../view-foundations/spec.md) § Security Requirements → Redirect Validation already governs it, and this capability inherits those rules and adds no redirect of its own.

Base names, notes and tags, if a store for them is ever established, are player-authored text and MUST be rendered as text. This capability MUST NOT introduce a path that renders any such value as markup.

## Accessibility Requirements

This spec involves user-facing UI. The following are MANDATORY per WCAG 2.1 AA, and add to SPEC-0005's baseline — including its token contrast constraints — which is not restated here.

### WCAG 2.1 AA Compliance

All UI components produced by this spec MUST meet WCAG 2.1 Level AA conformance as the minimum accessibility target.

### ARIA Landmarks

The set of cards MUST be exposed as a single navigable region, so a screen-reader user can move past the whole build list without traversing every row of every base.

### Icon-Only Controls

Every icon-only control MUST carry an `aria-label`. Producer-type and status glyphs MUST NOT be the sole accessible name of anything; each is accompanied by its text label.

### Dynamic Content Regions

A configuration change — extractor class, fill duration, generator count or class, panel count — and any deficit fix MUST be announced through an `aria-live="polite"` region naming what changed and that figures updated. Announcements MUST NOT be `assertive`: a recompute is the expected result of the player's own action.

Where a copy-to-clipboard control exists, its success MUST be announced politely.

### Keyboard Navigation

Card selection, every configuration control, every collapsible section, and the deficit fix MUST be reachable and operable by keyboard. A collapsed section MUST expose its state to assistive technology, and its one-line summary MUST be available without expanding it.

### Focus Management

Focus MUST remain stable across a recompute: a control that triggers new figures MUST retain focus once they arrive, so a change does not send focus to the top of the card. Where a recompute removes the focused control, focus MUST move to a documented, predictable destination rather than being lost to the document body.

#### Scenario: Focus survives a recompute

- **WHEN** the extractor class is changed and new figures arrive
- **THEN** focus remains on the class control

#### Scenario: A collapsed section is legible when closed

- **WHEN** a producer section is collapsed
- **THEN** its summary and its collapsed state are available to assistive technology without expanding it

#### Scenario: A fix is announced politely

- **WHEN** the deficit fix is applied
- **THEN** a polite live region states the generators added and the resulting power position
