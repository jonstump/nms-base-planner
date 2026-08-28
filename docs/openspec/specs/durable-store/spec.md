---
status: draft
date: 2026-08-28
implements: [ADR-0008]
requires: [SPEC-0005]
---

# SPEC-0009: Durable Store

## Graph Edges

- **Implements:** [ADR-0008](../../../adrs/ADR-0008-durable-user-data-store.md) — durable user data in a local-first store, stage 1
- **Requires:** [SPEC-0005](../view-foundations/spec.md) — the view-state boundaries this store sits beside, and the preferences it gives somewhere to live

## Overview

Where durable, player-authored data lives on the device: ticked construction items, stocked quantities, notes, tags, player-assigned names, and the view preferences that currently forget themselves on reload.

Realizes [ADR-0008](../../../adrs/ADR-0008-durable-user-data-store.md) **stage 1 only** — the local store, with no account, no server and no network. That ADR's stages 2 and 3 (accounts, then read-only sharing) are separate decisions with their own ADRs pending, and nothing here implements them. What this spec does carry from them is the schema room they need, because retrofitting an owner onto data that already exists is the expensive migration and ADR-0008 settled the shape to avoid it.

This is the first capability in the project that holds user data at all. `grep -rn "localStorage\|sessionStorage\|indexedDB" web/src web/tests web/index.html` returns nothing today, and the design README's storage prohibition is intact in code rather than merely on paper. ADR-0008 lifts it for durable data and keeps it for plan state; this spec is where that split becomes normative.

**What it unblocks.** SPEC-0007 REQ "Absent Data Is Absent" forbids the base planner card persisting anything until a governing decision establishes where it lives. ADR-0008 is that decision and is now `accepted`, so the clause is discharged — but the card still has nothing to persist into until this spec is implemented. This is what closes that gap.

## Requirements

### Requirement: A Workspace Owns Places

The store MUST hold exactly one workspace per device. The workspace MUST carry a `schemaVersion`, an `ownerId`, and a collection of place records.

`ownerId` MUST be nullable and MUST be null in stage 1, where no account exists. It MUST be present in the schema from the first version rather than added later: ADR-0008's migration works because sign-in attaches an owner to an existing workspace rather than re-keying its contents, and a field added in version 2 cannot do that for data written under version 1.

#### Scenario: The workspace exists before anything is stored in it

- **WHEN** the store is opened on a device that has never used it
- **THEN** a workspace exists with a null `ownerId`, the current `schemaVersion`, and no places

#### Scenario: Owner is absent, not missing

- **WHEN** a workspace written in stage 1 is inspected
- **THEN** `ownerId` is present and null, rather than the field being absent from the record

### Requirement: A Place Is One Record Type, Whatever Its Kind

A place MUST be represented by a single record type covering bases, freighters and settlements. ADR-0006 and ADR-0007 add two more surfaces, and for the purpose of durable user data they are the same kind of thing: a location a player authors notes and ticks against.

Each place MUST carry a stable `id` generated at creation, independent of any save file and independent of any account. It MUST carry `updatedAt` and a monotonically increasing `revision`.

`updatedAt` and `revision` MUST be written from the first version even though stage 1 has nothing to reconcile. ADR-0008 defers multi-device sync and conflict resolution to a later ADR and reserves this room deliberately; a store that adds them later cannot order edits made before they existed.

#### Scenario: Kind is a field, not a type

- **WHEN** a freighter and a base are both stored
- **THEN** both are place records distinguished by a kind field, and no second record type exists

#### Scenario: Identity does not come from the save

- **WHEN** a place is created by save import and the same place is later re-imported from a changed save
- **THEN** the place's `id` is unchanged, because it was generated at creation rather than derived from save contents

#### Scenario: Revision advances on every write

- **WHEN** a place is modified twice
- **THEN** its `revision` is strictly greater after the second write than after the first, and `updatedAt` reflects the later write

### Requirement: Versioned, and Fails Legibly

The store MUST carry a `schemaVersion` at the workspace and at each place.

An unrecognized version MUST load **nothing** and MUST report it. The store MUST NOT apply a partial load, MUST NOT drop records it cannot read while keeping ones it can, and MUST NOT migrate silently.

This is the standard `plan-hash.ts` already meets by returning `EMPTY_PLAN` through one path rather than applying a partial decode, and the standard ADR-0002 set for an unrecognized `BaseVersion`. A partially loaded workspace is indistinguishable to the player from a complete one.

#### Scenario: A future version loads nothing

- **WHEN** the store contains a workspace whose `schemaVersion` is higher than the running build understands
- **THEN** no place is loaded, and a diagnostic states both versions

#### Scenario: One bad place does not become a partial workspace

- **WHEN** one place record carries an unreadable `schemaVersion` and the rest do not
- **THEN** the load fails as a whole rather than returning the readable subset

### Requirement: An Empty Store Is a Designed State

An empty store MUST be a state the application presents deliberately, not an absence it renders as zeroes.

Cleared storage, a fresh device, and a private browsing window all produce it, and all three are ordinary rather than exceptional. A consumer of this store MUST distinguish "nothing stored" from "stored as zero", and MUST NOT render a figure the player never entered.

This is SPEC-0007 REQ "Absent Data Is Absent" applied to the store's own output: absent is rendered as absent.

#### Scenario: A fresh device is not an error

- **WHEN** the store is opened on a device with no prior data
- **THEN** the application presents an intentional empty state, and reports no failure

#### Scenario: Nothing stored is not zero stored

- **WHEN** a place has no stocked quantity recorded for an item
- **THEN** the consumer renders the quantity as absent rather than as `0`

### Requirement: Stage 1 Reaches No Network

Nothing in this capability MUST issue a network request. Stage 1 is local storage with no account, no server and no sync.

The absence MUST be checkable mechanically rather than by review, and the check MUST assert on this capability's own call paths rather than on the absence of network code in the application bundle — the bundle will contain network code by design once ADR-0008 stage 2 ships, and a check phrased against the bundle would then be weakened to accommodate it.

#### Scenario: Reading and writing issue no request

- **WHEN** the store is opened, read from, and written to
- **THEN** no network call of any kind is issued

#### Scenario: The check survives a sync client existing

- **WHEN** the application also contains code that makes network requests for unrelated reasons
- **THEN** the assertion still holds and still fails if a request is added to a store path

### Requirement: Nothing Is Marked for Synchronization

No record written in stage 1 MUST be marked shared, synced, or pending upload.

ADR-0008's compatibility line with ADR-0002 is that nothing derived from a save reaches a server unless the player deliberately shared the place it belongs to. A stage 1 store that pre-marked its records would make stage 2's first sign-in an upload the player never chose, which is that ADR being overturned by default rather than by decision.

Where the schema carries fields serving stages 2 and 3 — `ownerId`, and any share state — they MUST be present and unset rather than absent.

#### Scenario: A stored place is not queued for anything

- **WHEN** any place is written
- **THEN** it carries no flag marking it shared, synced, or pending upload

### Requirement: View Preferences Survive a Reload

View-local preferences that SPEC-0005 REQ "View State Boundaries" permits the view to hold MUST be persisted through this store and MUST be restored on load.

A preference that forgets itself on reload is not a preference. SPEC-0005 permits the view to hold them and `ViewState.preferences` holds exactly two — `groupSeparator` and `showUnverified` — with nowhere to survive a page load.

Persisting them MUST NOT move them out of view state. They remain interface state that the view owns; the store is where the view's own copy is written and read, and the plan, the resolved graph and every derived quantity MUST remain outside both.

#### Scenario: A preference outlives the page

- **WHEN** a player changes a view preference and reloads
- **THEN** the preference is as they left it

#### Scenario: Persistence does not widen view state

- **WHEN** the view's state is inspected after a plan is resolved and preferences are restored
- **THEN** it holds selection, collapse, inputs, focus and preferences, and no plan, graph or derived quantity

### Requirement: Deletion Is a First-Class Operation

The application MUST offer the player a way to delete everything this store holds, without requiring browser developer tools or a manual site-data clear.

ADR-0002 listed "needs no upload endpoint, retention policy, or deletion story" as a benefit of holding nothing. This capability spends that, and the deletion story is owed at stage 1 even though the retention story belongs to the server stages.

Deletion MUST remove the workspace and every place in it, MUST be confirmed before it runs, and MUST leave the application in the designed empty state rather than in an error state.

#### Scenario: The player can delete their data from the application

- **WHEN** the player chooses to delete stored data and confirms
- **THEN** the workspace and every place are removed, and the application presents the empty state

#### Scenario: Deletion is not reachable by accident

- **WHEN** the deletion control is activated
- **THEN** the action is confirmed before anything is removed

### Requirement: Storage Is Evictable and the Application Must Not Imply Otherwise

The application MUST NOT present locally stored data as guaranteed to persist.

Browsers evict origin storage under pressure, and private browsing windows discard it on close. ADR-0008 records this as a cost of local-first: until an account exists there is no recovery path, so "saved" is a stronger claim than the storage makes.

Where the application indicates that data is stored, the indication MUST be accurate about its scope — on this device — and MUST NOT use language implying a backup or a guarantee.

#### Scenario: Stored does not read as backed up

- **WHEN** the application indicates that a change has been stored
- **THEN** the indication does not claim the data is backed up or synchronized

### Requirement: Screenshots Are Local-Only

Where the store holds an image, it MUST be held locally and MUST NOT be shareable or synchronizable.

ADR-0008 defers blob storage to a later ADR and excludes it from that decision, on the measured grounds that one capture is 1.5–3 MB against 596 KB for a 200-place text workspace, and that blobs carry a different cost, abuse and moderation profile. Stage 1 MAY store images locally; nothing else about them is specified here.

Until that ADR exists, the application MUST NOT offer a control to share or upload an image.

#### Scenario: No share control for an image

- **WHEN** a place holds an image
- **THEN** the application offers no control whose effect would be to share or upload it

### Requirement: Error Handling Standards

All error-producing operations in this capability MUST follow structured error handling:

- Errors MUST be wrapped with contextual information at each layer boundary, naming the workspace or place being read or written when the failure occurred
- Sentinel errors MUST be defined for the failure modes a caller distinguishes programmatically — unsupported version, quota exceeded, storage unavailable, record not found — and MUST be selectable by identity rather than by message text, matching the discipline SPEC-0002 and the existing boundary client already enforce
- Silent error swallowing MUST NOT occur. A quota failure in particular MUST NOT be discarded: a write that did not happen, reported as one that did, is the failure mode that loses a player's work
- Structured logging MUST be used for error reporting

#### Scenario: A failed write is not reported as a success

- **WHEN** a write fails because the storage quota is exceeded
- **THEN** the failure is returned to the caller and surfaced, and the application does not indicate that the change was stored

#### Scenario: Callers branch on identity, not prose

- **WHEN** the application distinguishes an unsupported version from unavailable storage
- **THEN** it selects on the sentinel error, and no source or test matches on message text

### Requirement: Storage Operation Standards

All storage operations MUST follow structured data access patterns:

- Transactions MUST be used for multi-step mutations that require atomicity. Writing a place and advancing the workspace's state are one unit, and a store that can complete the first without the second can produce a workspace that disagrees with its own contents
- Connection lifecycle MUST be explicitly managed, with the database opened once and version-change events handled rather than ignored — an unhandled version change blocks the upgrade indefinitely and presents as the application hanging on load
- The parameterized-query requirement does not apply: this store has no query language and no string-composed queries. It is recorded here as considered and inapplicable rather than omitted

#### Scenario: A multi-step write is atomic

- **WHEN** a write that touches a place and the workspace fails partway
- **THEN** neither change is applied, and the store is left as it was

#### Scenario: A version change does not hang the application

- **WHEN** another tab holds the database open at an older version and an upgrade is attempted
- **THEN** the version-change event is handled and the condition is surfaced, rather than the load blocking indefinitely

## Security Requirements

This capability is the first in the project to hold user data. It ships as part of a browser-rendered client with no server component, no accounts and no HTTP endpoints **in stage 1**. Each topic is recorded with its applicability so an uncovered one is visible rather than absent, and several change at ADR-0008 stage 2.

### Authentication

Not applicable in stage 1. There is no account, no session and no protected resource — `ownerId` exists in the schema and is null. ADR-0008 stage 2 introduces identity and it is ADR-0009's subject; when it lands, this topic MUST be answered rather than inherited from here.

### Rate Limiting

Not applicable. All operations are local, invoked by the player against their own device. There is no shared resource to exhaust and no remote call to throttle.

### Security Headers

Deferred to the application shell, which owns document delivery, per SPEC-0005 § Security Requirements → Security Headers. This capability contributes no headers and MUST NOT weaken any the shell sets; it introduces no requirement for inline script or `eval`.

### Request Body Size Limits

Applicable in an adapted form: there is no request, but there is a quota, and it is finite and shared with everything else the origin stores.

A bound MUST be enforced on what a single place may hold, and the store MUST fail a write that would exceed it rather than attempting it and discovering the quota. The value MUST be derived from measurement rather than guessed — ADR-0008 measured the text case at 596 KB for a 200-place workspace and excluded images, which are three orders of magnitude larger, so the bound MUST be set with images in scope or out of it explicitly.

#### Scenario: An oversized write is refused before it is attempted

- **WHEN** a write would take a place beyond the configured bound
- **THEN** it is refused with a message stating the limit, rather than attempted and failing on quota

### CSRF Protection

Not applicable in stage 1. There is no state-changing request, no session and no server to forge a request against.

### Redirect Validation

Applicable. Stored values are attacker-influenced in two ways: a place created by save import carries names from a file the player did not write, and ADR-0008 stage 3 will introduce records authored by another person.

No value read from this store MUST be used to navigate, MUST be injected as markup, or MUST be used as a URL, image source, or link target. A note is text and MUST be rendered as text. This is the treatment #78 established for a decoded URL hash and SPEC-0008 applies to a parsed save — one rule, now three sources.

#### Scenario: A stored value cannot navigate or inject

- **WHEN** a place's name or note contains a `javascript:` URL or markup
- **THEN** it renders as literal text, drives no navigation, and is not interpreted

## Accessibility Requirements

**Deliberately absent, and recorded so the absence is visible rather than an oversight.**

This capability defines no component, no control and no template. Its one presentation requirement — REQ "An Empty Store Is a Designed State" — constrains what consumers render rather than rendering anything itself, and every consumer is a view surface already governed by SPEC-0005's accessibility baseline: WCAG 2.1 AA, landmarks, `aria-label` on icon-only controls, `aria-live` on recompute, keyboard operation, and focus management, all enforced mechanically by the checks SPEC-0005's test stories added.

Two controls this spec requires — deletion, and any indication that data was stored — are built by a consuming surface and inherit that baseline there. The deletion confirmation in particular is a dialog and MUST use the shell's focus trap rather than its own.
