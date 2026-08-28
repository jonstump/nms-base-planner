---
status: draft
date: 2026-08-28
implements: [ADR-0002]
requires: [SPEC-0002, SPEC-0004, SPEC-0005]
---

# SPEC-0008: Save Import

## Graph Edges

- **Implements:** [ADR-0002](../../../adrs/ADR-0002-client-side-save-import.md) — client-side save import, read-only, delivered in stages
- **Requires:** [SPEC-0002](../wasm-boundary/spec.md) — the envelope imported records cross in, and the error codes failures report through
- **Requires:** [SPEC-0004](../tier1-normalizer/spec.md) — the parts catalog the built-inventory stage joins against, and the pipeline `mapping.json` arrives through
- **Requires:** [SPEC-0005](../view-foundations/spec.md) — the import surface is a view surface and inherits its rules rather than restating them

## Overview

Reading a player's No Man's Sky save file to bootstrap base records, so that starting a plan does not mean typing twelve portal glyphs per base by hand.

Realizes [ADR-0002](../../../adrs/ADR-0002-client-side-save-import.md). That decision's load-bearing clause is a negative one: **the save file must never leave the browser.** A save is the player's entire game state — discovered systems, inventory, platform UID, every base location — and is far more than the planner needs. Parsing therefore runs in the Go/WASM core on the device, and import is strictly read-only.

**Nothing in this capability is built.** No package under `internal/` or `cmd/` references `PersistentPlayerBases`, `BaseVersion`, or `mapping.json`, and none imports `net/http`. The confirmation ADR-0002 describes — a test asserting no network request during parse — does not exist because the parse path does not exist. This spec is written before the code rather than after it, and several requirements below exist to stop the code being written against assumptions nobody checked.

The import surface inherits SPEC-0005 wholesale: tokens, component styling, the prohibition on computing domain values, the single boundary client, view-state boundaries, and the accessibility baseline. Those are not restated here.

## Requirements

### Requirement: Real-Save Verification

Acceptance MUST rest on a real save file, not on synthetic fixtures alone.

The format description this capability is built from — 16-byte block headers with magic `0xFEEDA1E5`, LZ4 payloads, unencrypted in 2002-and-later formats, decompressing to JSON with obfuscated three-character keys — is recorded in ADR-0002's prose and **has not been verified against a real save in this repository.** No `.hg` fixture exists; `.gitignore` excludes `*.hg`, `save*.hg`, `mf_save*.hg` and `testdata/saves/` deliberately, because a save is personal data that must not be committed.

A synthetic fixture built from that prose would agree with the prose by construction and would be evidence about nothing. This is the same failure this project has recorded four times: a bounded search reported as a general result.

The suite MUST therefore include a committed excerpt of a real save, reduced to the smallest span that exercises the parser and scrubbed of every field outside the extracted scope. A full-save test MUST be available and MUST be opt-in via an environment variable naming a local save path, skipping — not failing — when unset, so that a contributor without a save can still run the suite. A suite that passes with no real-save coverage at all MUST fail rather than report success.

#### Scenario: A real excerpt is present

- **WHEN** the test suite runs with no environment configuration
- **THEN** it parses a committed real-save excerpt, and a suite containing only synthetic fixtures fails

#### Scenario: The full-save test is opt-in, not silently absent

- **WHEN** the environment variable naming a save path is unset
- **THEN** the full-save test skips with a message stating how to enable it, rather than passing silently

#### Scenario: The excerpt carries only what is extracted

- **WHEN** the committed excerpt is inspected
- **THEN** it contains no field outside the staged extraction scope, and no platform identifier, inventory, or discovery data

### Requirement: The Save Never Leaves the Device

The parse path MUST issue no network request. No `fetch`, `XMLHttpRequest`, WebSocket, `sendBeacon`, or equivalent MUST occur between the file being read and the extracted records being produced.

The confirming test MUST assert on the **parse call path**, not on the absence of network code in the application bundle. Once ADR-0008's sync client ships, the bundle will contain network code by design, and a test phrased as "the bundle makes no requests" would then be weakened to accommodate it. A test that quietly loosens is worse than no test, because it reports a guarantee it has stopped checking.

#### Scenario: Parsing issues no request

- **WHEN** a save is parsed
- **THEN** no network call of any kind is issued during parse, asserted over the parse call path specifically

#### Scenario: The guarantee survives a sync client existing

- **WHEN** the application also contains code that makes network requests for unrelated reasons
- **THEN** the parse-path assertion still holds and still fails if a request is added to the parse path

### Requirement: Import Is Read-Only

The application MUST contain no code path that writes, modifies, or truncates a save file. Import parses, extracts, and discards.

Read-only MUST be structural rather than conventional: the absence of a save-writing function MUST be confirmable by a mechanical check over the source, in the way ADR-0002 describes and this project already applies to colour literals and message-text branching.

#### Scenario: No write path exists

- **WHEN** the source is searched for save-writing operations
- **THEN** none is found, and the check runs in CI rather than in a review checklist

#### Scenario: The file handle is not retained

- **WHEN** extraction completes
- **THEN** the decompressed save contents are released, and no copy is retained beyond the records extracted

### Requirement: Container Identification and Version Refusal

The parser MUST identify the container before interpreting it, and MUST refuse anything it does not recognize.

A file whose magic does not match MUST be rejected with a message distinguishing "this is not a save file" from "this save is damaged". A save whose format era predates the unencrypted range ADR-0002 names MUST be refused rather than attempted. An unrecognized `BaseVersion` MUST cause the import to produce **nothing** and report clearly, rather than partially populating.

The all-or-nothing rule is the same standard `plan-hash.ts` already meets by returning `EMPTY_PLAN` through one path rather than applying a partial decode: a partially imported set of bases is indistinguishable to the player from a complete one, and is wrong in a way they cannot see.

#### Scenario: A non-save file is distinguishable from a damaged save

- **WHEN** a file with the wrong magic is offered
- **THEN** the failure states that the file is not a save, distinctly from the failure a truncated save produces

#### Scenario: An unrecognized version imports nothing

- **WHEN** a save carries a `BaseVersion` the parser does not recognize
- **THEN** no base is imported, and the message names the version encountered

#### Scenario: A truncated save is refused rather than partially read

- **WHEN** a save ends mid-block
- **THEN** the import fails and produces no records, rather than returning the bases that parsed before the truncation

### Requirement: The Deobfuscation Table Is Version-Matched

Save JSON uses obfuscated three-character keys, resolved through the `mapping.json` table that ships with MBINCompiler and arrives through the SPEC-0004 pipeline.

The table's version MUST be recorded alongside the extracted records, and a mismatch between the table and the save's format MUST refuse the import rather than resolving keys speculatively. A key the table does not contain MUST be reported, not skipped: a silently dropped key is a field that appears absent, and REQ "Absent Data Is Absent" in SPEC-0007 makes absence meaningful.

#### Scenario: The table version travels with the result

- **WHEN** records are extracted
- **THEN** the `mapping.json` version used is recorded with them

#### Scenario: A mismatch refuses rather than guesses

- **WHEN** the deobfuscation table does not match the save's format
- **THEN** the import refuses and states both versions, rather than resolving the keys it happens to recognize

### Requirement: Staged Extraction Scope

Extraction MUST be limited to the stages ADR-0002 defines, and each stage MUST be independently shippable.

**Stage 1 — identity.** `Name`, `GalacticAddress` (from which the portal address derives), and `BaseType`, per base in `PersistentPlayerBases`. This alone removes manual glyph entry.

**Stage 2 — built inventory.** `Objects[].ObjectID` joined against the SPEC-0004 parts catalog, yielding per-base counts of the part classes the catalog names. This feeds pre-checked construction items and lets a power figure reflect existing generation and draw rather than assuming an empty site.

No field outside these stages MUST be extracted. A save contains a great deal this capability has no use for, and the privacy guarantee is strongest when the parser cannot produce what it never reads.

#### Scenario: Stage 1 ships alone

- **WHEN** only stage 1 is implemented
- **THEN** identity import works end to end, and no stage 2 field is required for it to be useful

#### Scenario: Nothing outside scope is extracted

- **WHEN** the extracted record set is inspected for any save
- **THEN** it contains only the stage 1 and stage 2 fields, and no inventory, discovery, platform identifier, or position outside a base's own record

### Requirement: Speculative Scope Is Not Specified

ADR-0002's third stage — container inventories feeding stocked-versus-needed figures — is marked **speculative and not yet confirmed reachable in the save.**

It MUST NOT be specified, implemented, or offered in the interface until its reachability is confirmed against a real save and the confirmation is recorded with the boundary of what was searched. A requirement written against an unconfirmed field is a requirement that cannot be satisfied or refuted.

#### Scenario: The unconfirmed stage stays out of the interface

- **WHEN** the import surface is rendered
- **THEN** it offers no control referring to container or storage import, since no specification covers it

#### Scenario: Confirmation is recorded before specification

- **WHEN** container inventories are found to be reachable
- **THEN** the sources searched and the save version examined are recorded, and only then may a requirement be written

### Requirement: Search Boundaries Are Recorded

Where a value is produced by searching the save rather than by reading a known path, the import result or its log MUST record which paths were searched.

This mirrors SPEC-0004 REQ "Search Boundaries Are Recorded" for the same reason: a derived value that does not say what was examined cannot later be told apart from one that was read directly, and this project has recorded four instances of a bounded search reported as a general result.

#### Scenario: A searched value carries its provenance

- **WHEN** a field is located by searching several save paths rather than reading one known path
- **THEN** the paths searched are recorded alongside the extracted value

### Requirement: Import Is Never Required

Manual entry MUST remain a first-class path. No flow MUST make import a prerequisite for using any surface, and the interface MUST NOT imply that import is required or that a manually-entered base is lesser.

ADR-0002 names the reason: console players cannot readily extract save files, so import cannot be the only onboarding path. Every import-fed field MUST have a manual equivalent.

#### Scenario: Every surface works without importing

- **WHEN** a player who has never imported a save uses any surface
- **THEN** it is fully functional, and no control is disabled pending an import

#### Scenario: No field is import-only

- **WHEN** a field is populated by import
- **THEN** the same field can be entered and edited by hand

### Requirement: Imported Records Have a Stated Destination

Import MUST state where its results go, and MUST NOT imply a persistence it does not have.

Until [ADR-0008](../../../adrs/ADR-0008-durable-user-data-store.md)'s stage 1 store exists, imported records are session-scoped: they populate the current session and do not survive a reload. The surface MUST say so plainly, and MUST NOT present a control whose effect would be to save them — the same standard SPEC-0007 REQ "Absent Data Is Absent" already sets.

Once the durable store exists, import MUST write into it as an ordinary authored edit, and MUST NOT mark the resulting records for synchronization. ADR-0008's compatibility line is that nothing derived from a save reaches a server unless the player deliberately shared the place it belongs to; an import that opted its own output into sync would overturn ADR-0002 by default rather than by decision.

#### Scenario: Session-scoped is stated, not discovered

- **WHEN** import completes and no durable store exists
- **THEN** the surface states that the records last for this session, and offers no control implying they are saved

#### Scenario: Import does not opt itself into sync

- **WHEN** import writes into the durable store and the player is signed in
- **THEN** the imported records are not marked shared or synced, and nothing is transmitted

### Requirement: Error Handling Standards

All error-producing operations in the parse and extraction path MUST follow structured error handling:

- Errors MUST be wrapped with contextual information at each layer boundary, naming the block, entry, or base being read when the failure occurred
- Sentinel errors MUST be defined for the failure modes a caller distinguishes programmatically — wrong format, unsupported version, truncated input, mapping mismatch — and MUST be selectable by identity rather than by message text, per SPEC-0002's existing discipline
- Silent error swallowing MUST NOT occur; every error MUST be returned, logged with context, or explicitly handled with a documented reason
- Structured logging MUST be used for error reporting

#### Scenario: A failure names where it happened

- **WHEN** parsing fails partway through a save
- **THEN** the error names the block or base being read, not only the operation that failed

#### Scenario: Callers branch on identity, not prose

- **WHEN** the import surface distinguishes an unsupported version from a corrupt file
- **THEN** it selects on the sentinel error, and no source or test matches on message text

## Security Requirements

This capability reads a file the player chooses, on the player's device, and produces records that stay there. It defines no endpoint and no server surface. Each topic below is recorded with its applicability so an uncovered one is visible rather than absent.

### Authentication

Not applicable. This capability defines no endpoints and no protected resources. Import is available signed out, and REQ "Import Is Never Required" forbids gating it behind anything.

### Rate Limiting

Not applicable. Parsing is local, invoked by the player against their own file. There is no shared resource to exhaust and no remote call to throttle.

### Security Headers

Deferred to the application shell, which owns document delivery, per SPEC-0005 § Security Requirements → Security Headers. This capability contributes no headers and MUST NOT weaken any the shell sets. In particular it introduces no requirement for inline script or `eval`, so a strict script CSP remains available; the WASM core already runs under `wasm-unsafe-eval` without it.

### Request Body Size Limits

Applicable, and **this spec cannot set the number.**

SPEC-0005 § Security Requirements → Request Body Size Limits requires a maximum accepted size be enforced before a file is read into memory, and records the value as unchosen. A save is decompressed in the page, so an oversized or maliciously-crafted file is a denial-of-service against the player's own tab.

A limit MUST be enforced before the file is read, and MUST be derived from measured real saves rather than guessed. No save exists in this repository to measure — see REQ "Real-Save Verification" — so the value MUST be set when the fixture lands, and MUST be recorded with the sizes it was derived from. Shipping the parser with no limit, or with an invented one, MUST NOT happen.

#### Scenario: The limit is enforced before the file is read

- **WHEN** a file exceeding the configured maximum is selected
- **THEN** it is refused before being read into memory, with a message stating the limit

### CSRF Protection

Not applicable. There is no state-changing request, no session, and no server to forge a request against.

### Redirect Validation

Applicable. A save file is untrusted input: it arrives from outside the application and its contents are attacker-controllable if a player is given a crafted file.

No value extracted from a save MUST be used to navigate, MUST be injected as markup, or MUST be used as a URL, image source, or link target. A base name is text and MUST be rendered as text. This is the same treatment #78 established for a decoded URL hash and ADR-0008 extends to a shared record — three sources of untrusted data, one rule.

#### Scenario: A crafted base name cannot navigate or inject

- **WHEN** a save contains a base name holding a `javascript:` URL or markup
- **THEN** it renders as literal text, drives no navigation, and is not interpreted

## Accessibility Requirements

This capability has a user-facing surface — file selection, an import review, and failure states. The following are MANDATORY per WCAG 2.1 AA and inherit the primitives SPEC-0005 established rather than reimplementing them.

### WCAG 2.1 AA Compliance

All UI produced by this capability MUST meet WCAG 2.1 Level AA as the minimum conformance target, verified by an automated audit that fails the build on a violation.

### ARIA Landmarks

The import surface mounts inside the shell's existing landmarks and MUST NOT introduce a second `banner`, `navigation`, `main`, or `contentinfo`. A duplicate landmark makes the landmark list ambiguous, which is worse than having none.

### Icon-Only Controls

Every icon-only control MUST carry an `aria-label` describing its purpose.

### Dynamic Content Regions

Import is a long-running operation with a result, so its progress and outcome MUST be announced through the shell's `aria-live="polite"` region. The announcement MUST correspond to the import completing, not to a render — the distinction SPEC-0005's live-region primitive already draws.

### Keyboard Navigation

File selection, import confirmation, and dismissal of any result or error MUST be fully keyboard-operable: logical tab order, Enter or Space to activate, Escape to dismiss. A file picker reachable only by pointer makes the whole capability unavailable to a keyboard user.

### Focus Management

Any dialog this capability opens MUST use the shell's focus trap: focus moves to the first focusable element on open, is contained while open, and returns to the invoking element on close by **every** route — Escape, backdrop, and the close control.
