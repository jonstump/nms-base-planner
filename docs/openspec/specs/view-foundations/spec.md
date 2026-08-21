---
status: approved
date: 2026-08-19
implements: [ADR-0004]
requires: [SPEC-0002]
---

# SPEC-0005: View Foundations

## Graph Edges

- **Implements:** [ADR-0004](../../../adrs/ADR-0004-react-view-layer.md) — React with TypeScript and Vite for the view layer
- **Requires:** [SPEC-0002](../wasm-boundary/spec.md) — the boundary the view consumes, and the only route to domain values

## Overview

The floor the view surfaces are built on: how tokens and borders are expressed, what the view is allowed to hold, how it talks to the Go core, and the accessibility behaviour every surface inherits.

ADR-0004 chose React on familiarity rather than on merit-in-isolation, and recorded that trade openly. What makes the trade cheap is ADR-0003's package boundary — a framework change costs the views and not the domain. This spec is where that separation stops being an intention and becomes something a reviewer can check: the view holds selection, collapse, form inputs and focus, and it derives no quantity of its own.

Scope is deliberately the foundations. The tree canvas (React Flow, elkjs, the method popover) and the base planner cards are separate capabilities that depend on this one; splitting them keeps each spec small enough to plan into stories and keeps a change to one surface from touching the other's requirements.

Three of ADR-0004's four Confirmation criteria are requirements below — tokens as custom properties, border discipline, and the view recomputing nothing. The fourth, accessibility being tested rather than assumed, is the Accessibility Requirements section.

## Requirements

### Requirement: Token Discipline

All colour, spacing, type and control-size values MUST be declared as CSS custom properties in a single global stylesheet, recreated from `docs/design/theme/handoff.md`.

Component styles MUST reference those custom properties and MUST NOT contain hardcoded colour literals. The theme reference computes its own contrast and colour-blindness validation tables from the token hexes at render time, so a value duplicated into a component is a value that has escaped that validation.

A token whose value the design reference does not state MUST NOT be invented in a component; it is added to the token file or the design is asked.

Two tokens carry conditional constraints that the theme reference states and this requirement restates by name, so a surface inherits them rather than rediscovering them from a contrast table: `--text-muted` measures 4.17:1 against `--panel-raised`, below AA for normal text, so against that surface it MUST be restricted to text 17px or larger or replaced with `--text`; `--text-dim` MUST be used only for decorative text 18px or larger, and MUST NOT be the only styling carrying information available nowhere else.

#### Scenario: A low-contrast token is used within its stated range

- **WHEN** a component sets text in `--text-muted` on a `--panel-raised` surface, or in `--text-dim`
- **THEN** the type size is at or above the size the token's contrast requires, and no information appears only in `--text-dim`

#### Scenario: Tokens live in one place

- **WHEN** the stylesheet is searched for colour literals outside the token file
- **THEN** none is found, and every component colour resolves through a custom property

#### Scenario: A new value is added to the token file

- **WHEN** a component needs a colour or spacing step the token file does not define
- **THEN** the value is added to the token file with its design provenance, rather than written inline

### Requirement: Component Styling Discipline

Borders MUST carry identity only. A 3px frame denotes identity; nothing else may write to a border.

The three interaction states MUST be expressed as the design specifies, because each was chosen to avoid a rendering defect rather than for appearance:

- Hover MUST be `filter: brightness(1.12)`
- Focus MUST be a 2px `--ok` outline, outboard
- Selection MUST be a 2px `--ok` ring, inboard, drawn by an overlay element

`inset box-shadow` MUST NOT be used for any of them. It paints under positioned children, which is the defect the overlay element exists to avoid.

Controls MUST use one scale: 40px default and 30px small. A row MUST NOT mix the two. Where the pointer is coarse, square targets MUST grow to at least 44px.

#### Scenario: Selection does not paint under children

- **WHEN** a selected element contains positioned children
- **THEN** the selection ring is drawn by an overlay element and remains visible over them

#### Scenario: A row keeps one control scale

- **WHEN** a row contains more than one control
- **THEN** every control in it is the same scale

#### Scenario: Coarse pointers get larger targets

- **WHEN** the primary pointer is coarse
- **THEN** square targets are at least 44px

### Requirement: The View Computes No Domain Values

The view MUST NOT perform arithmetic on quantities, power figures, producer counts, or any other value the domain produces. Every such figure MUST arrive from the boundary and be rendered as received.

This includes rounding. SPEC-0001 enumerates exactly which physical boundaries round and in which direction, and none of them is on the way to a screen. A rational the domain reports as `3/2` MUST NOT be converted through a floating-point number, and MUST NOT be rounded or truncated to a nearby value on the way to the screen.

The view MAY format for presentation — grouping separators, units, an exact decimal expansion, a truncation that carries the exact value on the same element — provided the formatting is reversible to the value received and changes no magnitude. `3/2` MAY therefore be set as `1.5`: the decimal terminates, so the figure displayed is the same number and the rational is recoverable from it. SPEC-0002 permits the boundary to send either form, so the received value may already be `1.5`. A rational with no terminating decimal MUST NOT be set as a decimal alone, because no such decimal is the value; it is set as the rational, or as a truncated decimal whose exact value is available on the element that carries it.

Which of those forms a surface uses is a design question rather than a view author's choice. `docs/design/theme/handoff.md` sets every quantity in JetBrains Mono with `tabular-nums`, a figure style that aligns digits into columns and has nothing to say about a solidus, and no design reference has yet shown a non-integer quantity. A surface spec that introduces one MUST state how the design sets it rather than leaving the choice to the component.

#### Scenario: A displayed total is the domain's

- **WHEN** the view renders a node total
- **THEN** the value came from the boundary payload, and no arithmetic produced it

#### Scenario: A fractional value is not rounded for display

- **WHEN** the boundary reports a quantity as an exact rational that is not an integer
- **THEN** the view displays the exact value, and does not round it to a nearby value or convert it through a floating-point number

#### Scenario: An exact decimal is a representation, not a computation

- **WHEN** the boundary reports a quantity whose rational has a terminating decimal expansion
- **THEN** the view MAY set it as that decimal, and a reader can recover the rational from what is shown

#### Scenario: A repeating rational keeps its exact value on the element

- **WHEN** the boundary reports a quantity whose rational has no terminating decimal expansion
- **THEN** the view sets the rational itself, or a truncated decimal whose exact value is carried on the same element, and never a bare decimal

#### Scenario: Changing an input recomputes through the core

- **WHEN** the user changes target quantity, a method, a recipe, or a base assignment
- **THEN** the new figures come from a boundary call, and none is derived in the view from the previous figures

### Requirement: Boundary Client

The view MUST reach the domain only through the module surface SPEC-0002 defines, and MUST NOT read the Tier 1 artifact directly.

The client MUST verify the module's contract version against the version it was built for before consuming any payload, and MUST report a mismatch naming both versions rather than proceeding.

The client MUST treat the envelope as SPEC-0002 defines it: exactly one of a result payload or an error payload. It MUST branch on the error payload's stable code and MUST NOT parse the human-readable message to determine failure kind.

The client MUST distinguish the module not yet being ready from a call having failed, and MUST NOT present a not-ready state as an error.

#### Scenario: Version mismatch is refused, not consumed

- **WHEN** the module reports a contract version the view was not built against
- **THEN** the view reports the mismatch naming both versions and does not consume the payload

#### Scenario: Failure kind comes from the code

- **WHEN** a call returns a failure envelope
- **THEN** the view selects its handling from the error code alone, and the message is displayed as diagnostic text only

#### Scenario: Not ready is not an error

- **WHEN** a call is made before the module has loaded its artifact
- **THEN** the view presents a loading state rather than a failure, and retries once readiness resolves

### Requirement: View State Boundaries

The view MUST hold only interface state: selection, section collapse, form inputs, focus, and view-local preferences.

The view MUST NOT hold the plan, the resolved graph, or any derived quantity as its own source of truth. Where a boundary result is cached to avoid a redundant call, the cache MUST be invalidated by the inputs that produced it, and MUST NOT be edited in place.

Plan state that persists MUST be carried as SPEC-0002 encodes it, so that a plan in a URL and a plan in the view are the same value.

#### Scenario: The view holds no plan of its own

- **WHEN** the view's state is inspected after a plan is resolved
- **THEN** it holds selection, collapse, inputs and focus, and no independent copy of the plan or its derived figures

#### Scenario: A cached result is invalidated by its inputs

- **WHEN** an input contributing to a cached boundary result changes
- **THEN** the cached result is discarded rather than adjusted

### Requirement: Module Loading

The WASM module and the layout engine MUST be loaded lazily rather than on first paint, because both are large enough to dominate load time and neither is needed to render the shell.

While the module is loading the view MUST remain interactive and MUST indicate that domain figures are not yet available, rather than presenting empty or zero values as though they were results.

A module that fails to load MUST be reported distinctly from an artifact that fails to validate, per SPEC-0002's separation of the two.

#### Scenario: The shell renders before the module

- **WHEN** the application first paints
- **THEN** the shell is interactive and the WASM module has not been fetched

#### Scenario: Absent figures are not shown as zero

- **WHEN** the module has not finished loading
- **THEN** figures dependent on it are shown as pending, not as zero

## Security Requirements

This spec covers a browser-rendered application. It has no server: the deployment is static hosting, the Go core runs in the page, and ADR-0002 keeps save-file parsing client-side. Several topics below are therefore satisfied by the absence of a surface rather than by a control — stated explicitly, because "there is no server" is a fact a future reader needs, and a heading quietly dropped is indistinguishable from a topic nobody considered.

### Authentication

There are no accounts and no server session. The application MUST NOT collect credentials, and MUST NOT transmit save-file contents, plan state, or any user data off the device.

### Rate Limiting

There are no application endpoints to rate-limit; the only requests are for static assets, which are the host's concern. The application MUST NOT introduce a network call that a user action can drive in an unbounded loop.

### Security Headers

The deployment MUST serve a Content Security Policy. The policy MUST permit WebAssembly compilation, MUST NOT permit `unsafe-eval` beyond that, and MUST NOT permit inline script. It MUST restrict `connect-src` to the origin, since no cross-origin call is legitimate for this application.

### Request Body Size Limits

Save-file import is untrusted input from the user's disk. The view MUST enforce a maximum accepted file size before reading a file into memory, and MUST report a file over that limit as a refusal rather than attempting to parse it.

### CSRF Protection

There are no state-changing server routes, so there is no cross-site request forgery surface. Should a server route ever be added, this section MUST be revisited before it ships.

### Redirect Validation

Plan state is carried in the URL hash. The view MUST treat URL-derived state as untrusted input: it MUST validate it through the same decoding path as any other plan input, and a hash it cannot decode MUST produce an empty plan and a diagnostic rather than a partially-applied one. The application MUST NOT navigate to a URL taken from decoded state.

## Accessibility Requirements

This spec covers user-facing UI. The following are MANDATORY per WCAG 2.1 AA, and they are the baseline every view surface inherits — the tree canvas and base planner specs add to these rather than restating them.

### WCAG 2.1 AA Compliance

All UI components produced under this spec MUST meet WCAG 2.1 Level AA as the minimum conformance target. Colour MUST NOT be the sole carrier of any distinction: every state that colour marks MUST also carry a glyph, a label, or text.

### ARIA Landmarks

Page structure MUST include ARIA landmark roles: `role="banner"` on the header, `role="navigation"` on navigation regions, `role="main"` on the primary content area, and `role="contentinfo"` on the footer.

### Icon-Only Controls

Every icon-only control with no visible text label MUST carry an `aria-label` describing its purpose.

### Dynamic Content Regions

Every recompute MUST announce through an `aria-live="polite"` region, naming what changed and that totals updated. Critical status changes MUST use `aria-live="assertive"`.

### Keyboard Navigation

All interactive elements MUST be keyboard operable: a logical tab order following the visual layout, Enter and Space to activate controls, Escape to dismiss popovers and dialogs, and arrow keys within composite widgets.

### Focus Management

Popovers and dialogs MUST trap focus while open, MUST move focus to the first focusable element on open, and MUST return focus to the invoking element on close.

#### Scenario: A recompute is announced

- **WHEN** a user action causes domain figures to change
- **THEN** a polite live region announces what changed and that totals updated

#### Scenario: Focus returns to the invoking element

- **WHEN** a popover opened from a control is closed by any means
- **THEN** focus returns to that control

#### Scenario: Colour is never the only signal

- **WHEN** a state is distinguished by colour
- **THEN** it also carries a glyph, label, or text conveying the same distinction
