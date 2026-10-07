---
status: draft
date: 2026-10-06
implements: [ADR-0016, ADR-0004]
requires: [SPEC-0001, SPEC-0002, SPEC-0005, SPEC-0007, SPEC-0009, SPEC-0011]
---

# SPEC-0012: Planner Panel

## Graph Edges

- **Implements:** [ADR-0016](../../../adrs/ADR-0016-one-owner-for-the-rollup-crossing.md) — one owner for the stage-2 and stage-3 crossings, and per-place domain configuration as player data
- **Implements:** [ADR-0004](../../../adrs/ADR-0004-react-view-layer.md) — the React view layer this surface belongs to
- **Requires:** [SPEC-0001](../rollup-engine/spec.md) — the producer rollup and power computation this panel is the sole caller of
- **Requires:** [SPEC-0002](../wasm-boundary/spec.md) — the `rollup` and `power` entry points, and the payloads the cards render
- **Requires:** [SPEC-0005](../view-foundations/spec.md) — tokens, styling discipline, the no-arithmetic rule, state boundaries, module loading and the accessibility baseline, inherited rather than restated
- **Requires:** [SPEC-0007](../base-planner-card/spec.md) — the card this panel arranges, and whose scope note deferred this spec
- **Requires:** [SPEC-0009](../durable-store/spec.md) — the place record that per-place site and power configuration now lives on
- **Requires:** [SPEC-0011](../shell-surface/spec.md) — the surface set this panel joins, and the hash/store split it applies to a domain input

Governing context that is not a frontmatter edge, because this spec depends on the decisions rather than on a spec realizing them: [ADR-0008](../../../adrs/ADR-0008-durable-user-data-store.md) (the store configuration is written to, and its schema-versioning discipline), [ADR-0010](../../../adrs/ADR-0010-places-first-and-the-shell.md) (surfaces as shell view state, `BaseID` as the place `id`), [ADR-0001](../../../adrs/ADR-0001-two-tier-nms-data-ingestion.md) (the Tier 2 curated constants every crossing carries). [SPEC-0006](../tree-canvas/spec.md) produces the assignments this panel costs, and [SPEC-0010](../base-atlas/spec.md) REQ "The Atlas Is a Surface in the Shell" is the precedent REQ "The Panel Is a Surface in the Shell" follows.

## Overview

The surface that arranges base planner cards: one card per place the plan has given work to, the leaves it has not placed, and the controls that shape both.

[SPEC-0007](../base-planner-card/spec.md) § Scope deferred this deliberately — *"the panel that arranges cards ... is application-shell furniture and belongs with the shell surface, which has no spec yet"* — and its design named the panel's contents as explicit non-goals. The card is complete and the panel is the reason it has never appeared on screen.

This spec is also where [ADR-0016](../../../adrs/ADR-0016-one-owner-for-the-rollup-crossing.md) becomes requirements. That decision found that nobody owned the stage-2 and stage-3 crossings: two hooks each sent half a rollup and neither kept the answer, so nothing in the application could produce a `BaseBuild`. The panel is the owner it names.

What it is not: the card's internals (SPEC-0007), the canvas that produces assignments (SPEC-0006), the Atlas (SPEC-0010), the freighter and settlement card variants (ADR-0006, ADR-0007), or save import (SPEC-0008).

## Requirements

### Requirement: One Owner for the Stage-2 and Stage-3 Crossings

Exactly one module MUST issue the `rollup` and `power` calls for this surface. No card, no canvas module, and no other surface MAY call either entry point.

One settled change to the plan or to any place's configuration MUST produce at most one `rollup` and one `power` call. A panel rendering *n* cards MUST NOT issue *n* crossings.

The decoded `Build` and `Power` MUST be held by that owner, MUST be invalidated by the inputs that produced them, and MUST NOT be edited in place, per [SPEC-0005](../view-foundations/spec.md) REQ "View State Boundaries".

The single owner MUST be checkable mechanically rather than by review: a source scan for the two entry points outside the owning module, in the manner of `tests/boundary/discipline.spec.ts`.

#### Scenario: One change, one crossing

- **WHEN** a player changes one base's extractor class while three cards are rendered
- **THEN** exactly one rollup and one power call are dispatched, and the figures on every card come from them

#### Scenario: No other module crosses

- **WHEN** the view sources are scanned for the `rollup` and `power` entry points
- **THEN** only the owning module calls either

#### Scenario: A superseded reply is dropped

- **WHEN** two configuration changes are made in quick succession and the replies settle out of order
- **THEN** the figures shown are the later change's, and the earlier reply is discarded rather than rendered

### Requirement: The Panel Composes From One Build Payload

The panel MUST render one card per base in `Build.bases`, and MUST NOT render a card for a place the payload does not report.

Card order MUST be derived from the payload rather than from render timing, so that two renders of one payload produce the same order.

A place that exists in the workspace but has no demands in the current plan MUST NOT be presented as a base with nothing to build. Whether such a place appears at all is the panel's choice; presenting it as an empty card is not, because an empty card is indistinguishable from a card whose figures failed to arrive.

#### Scenario: Cards follow the payload

- **WHEN** a plan assigns leaves to two of four places
- **THEN** two cards are rendered, and the two places with no demands are not shown as empty cards

#### Scenario: Order is stable

- **WHEN** the same build payload is rendered twice
- **THEN** the cards appear in the same order both times

### Requirement: An Unconfigured Place Reports Unsited Demands, Not Absent Ones

A place carrying demands but no site configuration MUST have its demands presented as unsized, from `BaseBuild.unsited`, and MUST NOT be presented as a place with nothing to build.

The panel MUST NOT substitute a default extractor class or fill duration in order to produce a count. The domain refuses to size an extractor without them, and a figure the panel supplied the inputs for is not the domain's figure.

The route to configuring the place MUST be reachable from the card reporting the unsited demands.

#### Scenario: Unsited is a state, not an absence

- **WHEN** a leaf is assigned to a place that has never been configured
- **THEN** the card lists the demand as unsized and offers the configuration controls, rather than showing no rows

#### Scenario: No invented site

- **WHEN** a place has no configuration
- **THEN** no extractor count, fill time or power draw for it is shown

### Requirement: The Unassigned Bin Is the Plan's Leftovers

The panel MUST present `Build.unassigned` — the leaves the plan has not placed — and MUST NOT present them as a base.

The bin MUST be distinguishable from a card by more than position or colour, per [SPEC-0005](../view-foundations/spec.md) § Accessibility Requirements — colour MUST NOT be the sole carrier of the distinction. It is not a place: it has no identity, no configuration, and no power position.

An empty bin MUST NOT be rendered as a base with nothing in it.

#### Scenario: Unplaced leaves are visible

- **WHEN** a plan resolves with leaves assigned to no place
- **THEN** those leaves are listed as unassigned, and no card is drawn for them

#### Scenario: The bin is not a base

- **WHEN** the unassigned bin is inspected
- **THEN** it offers no site configuration, no power controls and no base identity

### Requirement: Per-Place Domain Configuration Is Player Data

A place's site configuration and power generation setup MUST be persisted on its place record through the store [SPEC-0009](../durable-store/spec.md) defines, and MUST be restored on load.

Such a value MUST NOT be encoded into the URL hash in either direction, per [SPEC-0011](../shell-surface/spec.md) REQ "The Hash Owns the Plan, the Store Owns the Player". It is player-authored, and a shared link carries plan state only.

Persisting it MUST NOT move it into view state. It is an input the domain reads, held durably and sent with each crossing; the plan, the resolved graph and every derived quantity MUST remain outside both the store and view state.

A place with no stored configuration MUST read as unconfigured rather than as a default, so that REQ "An Unconfigured Place Reports Unsited Demands, Not Absent Ones" holds on first use.

#### Scenario: Configuration outlives the page

- **WHEN** a player sets a base's extractor class and fill duration and reloads
- **THEN** both are as they left them, and the figures are recomputed from them

#### Scenario: A share carries no configuration

- **WHEN** a hash is encoded from a workspace whose places carry site and power configuration
- **THEN** the encoded value contains plan state only, with no site or power configuration present

#### Scenario: A decoded hash configures nothing

- **WHEN** a hash is decoded
- **THEN** no place's configuration is created or modified as a result

### Requirement: Configuration Recomputes On Change; Plan Inputs Recompute On Request

A change to any place's site or power configuration MUST recompute through the boundary without further action, per [SPEC-0007](../base-planner-card/spec.md) REQ "Site Configuration" and REQ "Power Configuration Supports Mixed Sources".

A change to a plan input the player types — the target or the quantity — MUST NOT recompute until the player asks, because a partially typed value is not a plan. This asymmetry is deliberate and MUST NOT be reconciled by making configuration wait: configuration controls are discrete, every intermediate state of them is a plan the player could mean, and `tests/shell` already holds the typed-input case.

A free-text configuration entry MUST be committed before it recomputes, and an entry that is not an exact quantity MUST be held rather than sent, per [SPEC-0005](../view-foundations/spec.md) REQ "The View Computes No Domain Values".

#### Scenario: A picker recomputes immediately

- **WHEN** a player selects a different extractor class
- **THEN** the figures recompute through the boundary with no further action

#### Scenario: A half-typed target does not recompute

- **WHEN** a player is partway through typing a quantity
- **THEN** no crossing is dispatched until they request a recompute

#### Scenario: An inexact entry is held

- **WHEN** a fill-duration entry is not an exact quantity
- **THEN** it is not sent, and the previously computed figures are not replaced by figures derived from it

### Requirement: The Panel Reports No Figure It Was Not Given

The panel MUST NOT present any cross-base figure the domain did not supply. Neither `Build` nor `Power` carries a workspace-level aggregate, so a total generation figure, a total draw, or a longest-ready-time across bases MUST NOT appear.

A count of the cards rendered MAY be shown: it is the length of a list the panel received, not a quantity the domain computed.

`docs/design/base-planner/handoff.md` specifies a header summary of `3 BASES · Σ kPs GEN · READY ~t`. The base count is permitted; the other two are not, and their absence MUST read as a stated refusal rather than as an unfinished strip. Supplying them is a change to [SPEC-0001](../rollup-engine/spec.md) and [SPEC-0002](../wasm-boundary/spec.md) — an aggregate on the payload and a contract version — and MUST be made there if it is wanted, not here.

#### Scenario: No summed generation

- **WHEN** the panel is rendered with three bases generating power
- **THEN** no figure representing their combined generation appears

#### Scenario: The count is not a computation

- **WHEN** the panel renders three cards
- **THEN** it may state that three bases are shown

### Requirement: Figures Are Pending, Never Zero

While the module, the Tier 1 artifact or the Tier 2 curated constants are unavailable, the panel MUST indicate that figures are not yet available, and MUST NOT present empty or zero values as though they were results, per [SPEC-0005](../view-foundations/spec.md) REQ "Module Loading".

A curated constant set that failed to load MUST be reported distinctly from a module that failed to load, per [ADR-0001](../../../adrs/ADR-0001-two-tier-nms-data-ingestion.md) and the codes `web/src/boundary/contract.ts` defines. The two have different causes and different remedies, and the panel MUST NOT collapse them into one message.

Provenance MUST reach the panel unchanged: every producer figure resting on an unverified constant renders marked, per [SPEC-0007](../base-planner-card/spec.md) REQ "Provenance on Displayed Figures". The panel MUST NOT suppress a marker to reduce visual noise, and MUST remain legible when every row carries one, which is the current state of the curated set.

#### Scenario: Loading is not zero

- **WHEN** the panel is selected before the module has loaded
- **THEN** it indicates that figures are pending, and shows no zeroes in their place

#### Scenario: A missing constant set says which thing is missing

- **WHEN** the curated constants cannot be read but the module loaded
- **THEN** the panel reports the constants as the cause, distinctly from a module failure

### Requirement: The Panel Is a Surface in the Shell

The panel MUST be one of the shell's surfaces, selected by shell view state per [ADR-0010](../../../adrs/ADR-0010-places-first-and-the-shell.md) §4 and [SPEC-0011](../shell-surface/spec.md) REQ "Surfaces Are Shell View State". It MUST NOT introduce a router.

It MUST NOT introduce a second `role="navigation"` landmark, nor a second `banner`, `main` or `contentinfo`. The shell holds the only one of each.

It MUST remain listed in the surface switcher when its data is unavailable, presenting its own pending state rather than disappearing, so the set of surfaces does not change under the player.

#### Scenario: Selected by view state

- **WHEN** the panel is opened and the page is inspected
- **THEN** the URL path is unchanged and exactly one named navigation landmark exists

#### Scenario: Listed while unavailable

- **WHEN** the module cannot load
- **THEN** the panel remains in the switcher and presents a pending state when selected

### Requirement: Cross-Navigation Is a Content Link

A route from the panel to another surface — the tree canvas, the Atlas — MUST be a content link inside `main`, not a navigation landmark, following [SPEC-0010](../base-atlas/spec.md) REQ "The Atlas Is a Surface in the Shell".

Such a link MUST NOT be constructed from a value decoded from the hash, per [SPEC-0005](../view-foundations/spec.md) § Security Requirements → Redirect Validation.

#### Scenario: A cross-link is not a landmark

- **WHEN** the panel offers a route to the tree canvas
- **THEN** that control is a link within `main`, and the landmark count is unchanged

## Security Requirements

This capability is part of a browser-rendered client application. It ships as static assets and a WASM module, with no server component and no HTTP endpoints of its own. There is no endpoint table in this spec because there are no endpoints; each topic below is recorded with its applicability so an uncovered topic is visible rather than absent.

### Authentication

Not applicable. This capability defines no protected resource and gates no function on identity. Per [ADR-0008](../../../adrs/ADR-0008-durable-user-data-store.md) no account is required, ever, and the configuration this spec persists is local data on the player's own device.

### Rate Limiting

Per [SPEC-0005](../view-foundations/spec.md) § Rate Limiting the application MUST NOT introduce a call a user action can drive in an unbounded loop. REQ "One Owner for the Stage-2 and Stage-3 Crossings" is the narrowing this capability adds: one settled change produces at most one rollup and one power call regardless of how many cards are rendered, and REQ "Configuration Recomputes On Change; Plan Inputs Recompute On Request" keeps a free-text entry from crossing per keystroke.

### Security Headers

Owned by document delivery, not by this capability. This spec introduces no requirement for inline script or `eval` and MUST NOT weaken any policy set for the deployment.

### Request Body Size Limits

Not applicable. This capability accepts no uploaded file. Save import is [SPEC-0008](../save-import/spec.md)'s.

### CSRF Protection

Not applicable. There are no state-changing server routes; every configuration edit is a local store write. Should this surface ever gain a server route, [SPEC-0005](../view-foundations/spec.md) § CSRF Protection requires that section be revisited before it ships.

### Redirect Validation

Plan state arrives in the URL hash and is untrusted input. [SPEC-0005](../view-foundations/spec.md) § Redirect Validation governs it and this capability inherits those rules, adding no redirect of its own. REQ "Cross-Navigation Is a Content Link" forbids building a cross-surface link out of a decoded value, and REQ "Per-Place Domain Configuration Is Player Data" forbids the hash carrying configuration in either direction.

Place names reach this surface as card identity and are player-authored text. They MUST be rendered as text; this capability MUST NOT introduce a path that renders any such value as markup.

## Accessibility Requirements

This spec involves user-facing UI. The following are MANDATORY for every UI component this spec produces, per WCAG 2.1 AA:

- **WCAG 2.1 AA compliance** — the minimum conformance target
- **ARIA landmarks** — `role="banner"`, `role="navigation"`, `role="main"`, `role="contentinfo"` on page-structure elements
- **`aria-label` on icon-only controls** — every button or link with no visible text label
- **`aria-live` regions for dynamic content** — `polite` for routine updates, `assertive` for critical status changes (HTMX swaps, auto-refresh panels, real-time status)
- **Keyboard navigation** — logical tab order, Enter/Space activation, Escape to dismiss, arrow keys within composite widgets
- **Focus management in modals and dialogs** — trap focus while open, move focus to the first focusable element on open, return it to the trigger on close

The full checklist behind each line is the SDD plugin's `references/accessibility-requirements.md`; this section is the normative summary and is not expanded inline.

Two additions specific to this surface, neither of which is implied by the list above:

- A recompute that changes figures MUST be announced through the shell's existing `aria-live` region, naming what changed and that totals updated — and MUST NOT claim totals updated before the crossing has returned.
- Every operation the panel offers MUST be reachable without a pointing device, including each configuration control and the route to every cross-surface link.
