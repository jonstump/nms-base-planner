---
status: approved
date: 2026-08-18
implements: [ADR-0003, ADR-0004]
requires: [SPEC-0001]
---

# SPEC-0002: WASM Boundary

## Overview

The boundary between the Go domain core and the JavaScript view layer. ADR-0003 places the dependency graph, rollup engine, power math, save parsing, and plan serialization in a Go package that imports no `syscall/js`, and names a thin adapter package as the only code permitted to touch `js.Value`. This spec defines what that adapter exposes and what crosses it.

The boundary is where SPEC-0001's guarantees are most easily lost. That spec requires exact integer and rational arithmetic and forbids accumulating floating-point error across the graph — and JavaScript's only numeric type is IEEE-754 double, exact for integers only up to 2^53−1 against Go's int64 range of 2^63−1. A naive marshalling step discards at the last moment precisely what the engine was built to preserve. The encoding requirement below exists for that reason.

Per ADR-0004 the view renders and never recomputes domain values, so this boundary is also the mechanism by which that separation is enforceable rather than merely intended.

## Requirements

### Requirement: Boundary Surface

The adapter MUST expose a single named entry point per domain stage, registered on a single namespace object rather than scattered across the global scope. Stage 1 (`resolve`) is REQUIRED; `rollup` and `power` are RESERVED for stages 2 and 3 and MUST follow the same contract when added.

The surface MUST be coarse-grained: one call performs one complete stage. The adapter MUST NOT expose per-node, per-edge, or otherwise incremental accessors that would require repeated boundary crossings to assemble one result.

The adapter MUST NOT expose any function that mutates domain state. Every entry point is a pure computation from an input value to a result value.

#### Scenario: Single namespace

- **WHEN** the module has initialized
- **THEN** exactly one namespace object is registered, carrying the stage entry points, and no domain function is reachable from the global scope directly

#### Scenario: One crossing per stage

- **WHEN** the view resolves a plan and renders 36 nodes
- **THEN** exactly one boundary crossing occurred, and node data was read from the single returned value

#### Scenario: Reserved stages follow the same contract

- **WHEN** `rollup` or `power` is added in a later stage
- **THEN** it accepts and returns the same envelope shape defined by REQ "Result Envelope", with no bespoke calling convention

### Requirement: Exact Quantity Encoding

Every quantity crossing the boundary MUST be encoded as a decimal string, never as a JavaScript number. This applies to node totals, edge per-unit quantities, target quantity, recipe **yields**, and every derived count added by later stages.

The adapter MUST NOT convert a quantity to `float64` at any point in the encoding path. Where a total is not an exact integer, it MUST be encoded as an exact decimal or rational string that round-trips without loss.

Where the domain reports a value as inexact — `TotalInt` returning `false` per SPEC-0001 REQ "Exact Arithmetic and Rounding Discipline" — the adapter MUST NOT substitute a truncated, wrapped, or approximated value. It MUST encode the exact value as a string.

#### Scenario: Ordinary total crosses as a string

- **WHEN** Condensed Carbon resolves to a total of 300
- **THEN** the encoded value is the string `"300"`, not the number `300`

#### Scenario: Value beyond JavaScript safe-integer range survives

- **WHEN** a total exceeds 2^53−1, which JavaScript cannot represent exactly as a number
- **THEN** the encoded string carries the exact value, and parsing it as a `BigInt` on the consuming side yields that value unchanged

#### Scenario: Non-integer total is not rounded

- **WHEN** a later stage produces a total that is exactly one and a half
- **THEN** the encoded value represents that quantity exactly, and no rounding or truncation is applied at the boundary

#### Scenario: No float in the encoding path

- **WHEN** the adapter encodes any quantity
- **THEN** no conversion through `float64` occurs, verified by the absence of such conversions in the encoding code

### Requirement: Recipe Selection Crossing

A node's recipe selection is plan state, exactly as its method is, and MUST cross the boundary in both directions: inbound as part of the plan input, outbound as part of each node's reported options.

Per SPEC-0001 REQ "Recipe Selection" a node using its default recipe is representable without recording a selection. The encoding MUST preserve that: a plan in which every node uses its default MUST encode no recipe selections, so the boundary payload and the URL hash carry only deliberate overrides.

The adapter MUST report each node's legal recipes alongside its legal methods. The view MUST NOT be required to consult the artifact directly to discover alternatives, since that would put domain knowledge in the render layer that ADR-0004 keeps out of it.

#### Scenario: A selection round-trips

- **WHEN** a plan specifying a non-default recipe for one node crosses the boundary and is returned
- **THEN** that node reports the specified recipe, and its expansion reflects it

#### Scenario: Defaults encode nothing

- **WHEN** a plan in which every node uses its default recipe is encoded
- **THEN** the payload contains no recipe selections

#### Scenario: Alternatives reach the view

- **WHEN** the view receives a resolved graph
- **THEN** each node carries its legal recipes for the chosen method, without the view reading the artifact

### Requirement: Result Envelope

Every entry point MUST return a single envelope carrying an explicit success flag, exactly one of a result payload or an error payload, and the contract version. The envelope MUST NOT signal failure by returning a falsy value, an empty result, or by throwing a JavaScript exception carrying an unstructured string.

A failed call MUST NOT return a partial result alongside its error, consistent with SPEC-0001 REQ "Error Handling Standards".

#### Scenario: Success carries a payload and no error

- **WHEN** a call succeeds
- **THEN** the envelope reports success, carries the result payload, and carries no error payload

#### Scenario: Failure carries an error and no payload

- **WHEN** graph resolution fails
- **THEN** the envelope reports failure, carries the error payload, and carries no result payload — not an empty one

### Requirement: Sentinel Error Preservation

Each error crossing the boundary MUST carry a stable machine-readable code that identifies its domain sentinel, so a consumer can branch on failure kind without parsing prose. The code set MUST cover every sentinel defined by SPEC-0001 REQ "Error Handling Standards": unknown item, illegal method, cycle detected, missing constant, and invalid artifact.

Codes MUST be stable identifiers independent of Go error text — changing an error's message MUST NOT change its code. The human-readable message, including the wrapped resolution path, MUST also cross, but as a separate field that carries no contractual guarantee of format.

An error matching no known sentinel MUST cross with a distinct code reserved for unclassified failures rather than being silently mapped onto an unrelated sentinel.

#### Scenario: Sentinel is distinguishable without string parsing

- **WHEN** a plan names an item absent from the Tier 1 artifact
- **THEN** the error payload carries the code for unknown item, and the consumer branches on that code alone

#### Scenario: Message change does not change the code

- **WHEN** a domain error's wrapped message text is reworded
- **THEN** the code it crosses with is unchanged

#### Scenario: Unclassified error is not mislabelled

- **WHEN** an error matches none of the defined sentinels
- **THEN** it crosses with the reserved unclassified code, not with the code of an unrelated sentinel

### Requirement: Module Lifecycle and Readiness

The module MUST expose an explicit readiness signal that resolves only after the WASM instance has started and the Tier 1 artifact has been loaded and validated. Calling any entry point before readiness MUST fail with a defined error rather than returning an undefined value or hanging.

Artifact loading MUST be a distinct step from module instantiation, so an invalid artifact is reported as an artifact failure rather than a module failure.

The module SHOULD be loadable lazily, so that first paint does not wait on it.

#### Scenario: Calls before readiness fail cleanly

- **WHEN** an entry point is called before the readiness signal has resolved
- **THEN** it returns a failure envelope with the not-ready code, and does not hang or return undefined

#### Scenario: Invalid artifact is attributed correctly

- **WHEN** the module instantiates successfully but the supplied Tier 1 artifact fails validation
- **THEN** the failure is reported as an invalid-artifact error, not as a module load failure

### Requirement: Domain Purity Preservation

The domain package MUST NOT import `syscall/js`. The adapter package MUST be the only package in the module that does.

The adapter MUST NOT contain domain logic. It performs encoding, decoding, and error mapping only — no graph traversal, no quantity arithmetic, no provenance derivation. Any rule that determines a domain value MUST live in the domain package where it is testable without a browser.

The adapter's encoding and decoding MUST be testable without a browser and without a WASM toolchain, so the boundary's correctness does not depend on an integration environment.

#### Scenario: Import boundary holds

- **WHEN** the module's dependency graph is inspected
- **THEN** `syscall/js` is reachable only through the adapter package

#### Scenario: Adapter performs no arithmetic

- **WHEN** the adapter is inspected for quantity arithmetic, graph traversal, or provenance rules
- **THEN** none are present; it delegates every such determination to the domain package

#### Scenario: Encoding is testable in plain Go

- **WHEN** the encoding and decoding paths are exercised
- **THEN** they run under plain `go test` with no browser and no WASM build

### Requirement: Event Loop Safety

An entry point MUST NOT block the JavaScript event loop indefinitely, and MUST NOT re-enter JavaScript synchronously from within a call in a way that can deadlock the Go runtime's single WASM thread.

Where a computation could become long-running, the boundary SHOULD present an asynchronous contract rather than a synchronous one, so the page remains responsive.

#### Scenario: Page stays responsive during a call

- **WHEN** a resolve call executes
- **THEN** the page does not become unresponsive, and no deadlock occurs between the Go runtime and the JavaScript event loop

### Requirement: Contract Versioning

The boundary contract MUST carry a version, reported in every result envelope. The consuming view MUST verify that version against the one it was built for, and MUST fail with a clear diagnostic on mismatch rather than proceeding against an unexpected shape.

The version MUST change whenever the envelope shape, the encoding of quantities, or the sentinel code set changes.

#### Scenario: Mismatch is detected, not tolerated

- **WHEN** the view is built against one contract version and loads a module reporting another
- **THEN** it reports a version mismatch naming both versions, and does not attempt to consume the payload

### Requirement: Determinism Across the Boundary

Identical inputs MUST produce byte-identical encoded output, preserving the determinism SPEC-0001 REQ "Determinism" requires of the engine. Encoding MUST NOT introduce ordering that varies between runs, and MUST preserve the node ordering the domain produced.

Provenance flags MUST cross unchanged. A value the domain marked unverified MUST arrive marked unverified.

#### Scenario: Encoding is byte-stable

- **WHEN** the same plan input is resolved and encoded twice in the same process
- **THEN** the two encoded outputs are byte-identical

#### Scenario: Node order survives

- **WHEN** an encoded graph is decoded by the consumer
- **THEN** node order matches the domain's order — terminals first, target last

#### Scenario: Provenance survives

- **WHEN** a node is marked unverified by the domain
- **THEN** it arrives at the consumer marked unverified

### Requirement: Error Handling Standards

All error-producing operations MUST follow structured error handling:

- Errors MUST be wrapped with contextual information at each layer boundary (e.g., "decoding plan input: quantity must be positive, got -1")
- Sentinel errors MUST be defined for domain-specific failure modes that callers need to distinguish programmatically — at minimum, the boundary adds: not ready, malformed input, and contract version mismatch
- Silent error swallowing MUST NOT occur — every error MUST be either returned to the caller, logged with sufficient context, or explicitly handled with a documented reason for suppression
- Structured logging MUST be used for error reporting (key-value pairs, not string interpolation)

#### Scenario: Malformed input is rejected with context

- **WHEN** the view passes input that cannot be decoded into a valid plan
- **THEN** the failure names what could not be decoded, and no computation is attempted

#### Scenario: Boundary sentinels are distinguishable

- **WHEN** a call fails because the module is not ready, versus because the input was malformed
- **THEN** the two failures carry different codes
