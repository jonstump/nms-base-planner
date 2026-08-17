---
status: draft
date: 2026-08-17
implements: [ADR-0001, ADR-0003]
---

# SPEC-0001: Rollup Engine

## Overview

The rollup engine is the computational core of the base planner. Given a target item and quantity, it resolves the full crafting/refining/cooking dependency graph, propagates quantities down that graph, aggregates leaf resources, assigns them to bases, and converts each base's assignment into concrete producer counts and a power budget.

Both surfaces are views over this engine: the tree canvas renders its graph, and the base planner renders its per-base rollup. The design prototypes each reimplemented this math independently with sample constants; this spec defines the single implementation both surfaces consume.

Per ADR-0003 the engine lives in a Go package that imports no `syscall/js`, making it usable unchanged by the ingestion CLI and testable without a browser. Per ADR-0001 it consumes a two-tier dataset: an extracted recipe graph (Tier 1) and hand-curated economy constants (Tier 2).

Save file import (ADR-0002) and plan URL serialization are separate capabilities and are out of scope here.

## Requirements

### Requirement: Dependency Graph Resolution

The engine MUST resolve a target item and quantity into a directed acyclic graph of nodes, where each node carries an item identity, a resolved method, and a total required quantity. Expansion MUST terminate at nodes whose resolved method is terminal (`raw`), and MUST NOT expand beyond them.

The graph MUST be derived from the Tier 1 artifact. The engine MUST NOT contain hardcoded recipe data.

#### Scenario: Resolving the Stasis Device tree

- **WHEN** the target is Stasis Device at quantity 1 with default methods
- **THEN** the engine returns a graph of exactly 34 distinct nodes spanning the Quantum Processor, Cryogenic Chamber, and Iridesite branches

#### Scenario: Terminal nodes are not expanded

- **WHEN** a node's resolved method is `raw`
- **THEN** the node has no child edges, even when the Tier 1 artifact contains a recipe that could produce it

#### Scenario: Unknown target

- **WHEN** the requested target item ID is absent from the Tier 1 artifact
- **THEN** the engine returns an error identifying the missing ID, and returns no partial graph

### Requirement: Method Resolution

Each node MUST resolve to exactly one method from the set `craft`, `refine`, `raw`, `cook`. The engine MUST NOT define, accept, or produce a `buy` method — this is a build planner, not a shopping list.

The engine MUST report which methods are legal for a given node so the view can render unavailable options as inert rather than hiding them. Changing a node's method MUST change that node's expansion, and MUST trigger recomputation of all totals derived from it.

#### Scenario: Method change alters expansion

- **WHEN** a node's method changes from `raw` to `refine`
- **THEN** the node gains child edges for its refine inputs, and all ancestor quantities are recomputed

#### Scenario: Illegal method rejected

- **WHEN** a method is requested for a node that has no recipe of that kind in the Tier 1 artifact
- **THEN** the engine returns an error naming the node and the illegal method, and the plan is left unchanged

#### Scenario: No buy method exists

- **WHEN** any input requests the method `buy`
- **THEN** the engine returns an error indicating the method is not part of the vocabulary

### Requirement: Quantity Propagation and Aggregation

The engine MUST propagate required quantities from the target downward, multiplying each edge's per-unit quantity by its parent's total. Where the same item is required by multiple parents, the engine MUST aggregate those demands into a single total for that item.

Totals MUST scale linearly with the target quantity.

#### Scenario: Shared inputs aggregate

- **WHEN** the target is Stasis Device at quantity 1
- **THEN** Condensed Carbon totals 300 units, aggregated across all six recipes that consume 50 each

#### Scenario: Gas totals at quantity 1

- **WHEN** the target is Stasis Device at quantity 1
- **THEN** Sulphurine, Nitrogen, and Radon each total 500 units, each arising from two recipes consuming 250

#### Scenario: Linear scaling

- **WHEN** the target quantity changes from 1 to 10
- **THEN** every leaf total is exactly ten times its value at quantity 1

### Requirement: Cycle Detection

The engine MUST detect cycles during graph resolution and MUST return an error naming the participating nodes rather than recursing without bound. Refining relationships in the source data are capable of forming cycles, so this is a runtime condition and MUST NOT be assumed away.

#### Scenario: Cyclic method selection

- **WHEN** a combination of method selections would cause a node to appear as its own ancestor
- **THEN** the engine returns a cycle error listing the node IDs forming the cycle, and returns no graph

### Requirement: Exact Arithmetic and Rounding Discipline

All item quantities MUST be represented as exact integers. Multipliers that are not integers (such as extractor and generator class multipliers) MUST be applied as exact rational arithmetic. The engine MUST NOT accumulate binary floating-point error across the graph.

Rounding MUST occur only at stated physical boundaries, and MUST round up, because partial physical units cannot be built. The boundaries are: plants per crop, biodomes per crop, extractors per resource, supply depots per resource, generators per base, and batteries per base.

#### Scenario: Plants round up

- **WHEN** a crop requires 250 units at a yield of 32 units per plant
- **THEN** the engine reports 8 plants, not 7.8125

#### Scenario: Domes round up from plants

- **WHEN** a crop requires 17 plants at a dome capacity of 16
- **THEN** the engine reports 2 biodomes

#### Scenario: No intermediate rounding

- **WHEN** a quantity passes through multiple graph levels before reaching a leaf
- **THEN** the leaf total equals the exact product of the per-edge quantities, with no rounding applied at intermediate levels

### Requirement: Leaf Assignment to Bases

The engine MUST accept an assignment of leaf items to bases and MUST group leaf totals by their assigned base. Leaves with no assignment MUST be reported in a distinct unassigned group rather than being silently dropped or attributed to a default base.

#### Scenario: Leaves group by base

- **WHEN** crops are assigned to one base and gases to another
- **THEN** each base's rollup contains only its assigned leaf items

#### Scenario: Unassigned leaves are surfaced

- **WHEN** a leaf item has no base assignment
- **THEN** it appears in the unassigned group with its full required total

#### Scenario: Reassignment recomputes both bases

- **WHEN** a leaf is reassigned from one base to another
- **THEN** both the origin and destination base rollups are recomputed, including their power budgets

### Requirement: Producer Rollup

For each base, the engine MUST convert assigned leaf totals into producer requirements by producer type: `farm`, `extractor`, `ranch`, and `kitchen`. Producer counts MUST derive from Tier 2 constants supplied at call time and MUST NOT be hardcoded.

Farm rows MUST report plant count and biodome count. Extractor rows MUST report extractor count sized so the required quantity is produced within a configured fill duration at the site's configured class, together with the resulting fill time, and MUST report supply depots when the required quantity exceeds the configured depot threshold.

Extractor class MUST be configured per site, not per row.

Items whose demand is satisfied by a byproduct of another producer at the same base MUST be reported as requiring no construction, and MUST NOT contribute a producer count or a power draw.

#### Scenario: Farm rollup

- **WHEN** a base is assigned a crop requiring 200 units at a yield of 25 per plant and a dome capacity of 16
- **THEN** the engine reports 8 plants and 1 biodome for that crop

#### Scenario: Extractor sized to fill duration

- **WHEN** a base is assigned a gas requiring 500 units, with a class-B rate of 200 units per hour and a target fill duration of 1.5 hours
- **THEN** the engine reports 2 extractors and the resulting fill time

#### Scenario: Site class applies to all rows

- **WHEN** the extractor class at a base changes from B to S
- **THEN** every extractor row at that base recomputes its count and fill time, and no other base is affected

#### Scenario: Byproduct satisfies demand

- **WHEN** a base's Condensed Carbon demand is met by the byproduct of gas refining at that same base
- **THEN** the engine reports that item as requiring no construction, with no producer count and no power draw

### Requirement: Power Computation

For each base the engine MUST compute total generation, total draw, and the resulting surplus or deficit, using Tier 2 constants supplied at call time.

Generation MUST support two source types. Electromagnetic generators MUST apply a class multiplier to a base output. Solar panels MUST be classless and MUST additionally require batteries at a configured ratio for night coverage.

When draw exceeds generation, the engine MUST report the deficit and MUST report the number of additional generation units required to clear it, so the view can present the fix as an action rather than a warning.

#### Scenario: EM generation by class

- **WHEN** a base has 3 electromagnetic generators at class A, with a class-B base output of 110 kPs and a class-A multiplier of 1.5
- **THEN** the engine reports 495 kPs of generation

#### Scenario: Solar requires batteries

- **WHEN** a base is powered by 5 solar panels at a ratio of 1 battery per 2 panels
- **THEN** the engine reports 3 batteries as required

#### Scenario: Deficit reports the fix

- **WHEN** a base draws 400 kPs against 330 kPs of generation from class-B electromagnetic generators producing 110 kPs each
- **THEN** the engine reports a deficit of 70 kPs and reports that 1 additional generator clears it

#### Scenario: Downgrade reopens a deficit

- **WHEN** a base at surplus has its generator class downgraded such that generation falls below draw
- **THEN** the engine reports a deficit and the required additional unit count

### Requirement: Provenance Propagation

Every computed figure MUST carry provenance indicating whether all inputs contributing to it were verified. Where any contributing node or constant is marked unverified in the source data, the derived figure MUST be marked unverified.

The engine MUST NOT silently present unverified-derived values as verified.

#### Scenario: Unverified input taints derived total

- **WHEN** a node in a leaf's ancestry is marked unverified in the Tier 1 artifact
- **THEN** that leaf's total is marked unverified

#### Scenario: Unverified constant taints producer count

- **WHEN** a Tier 2 constant used in a producer calculation lacks a verified date
- **THEN** the resulting producer count is marked unverified

### Requirement: Determinism

Given identical inputs — target, quantity, method selections, base assignments, site configurations, and the Tier 1 and Tier 2 datasets — the engine MUST produce identical output. Iteration over unordered collections MUST NOT leak into output ordering.

#### Scenario: Repeated computation is stable

- **WHEN** the same plan input is computed twice in the same process
- **THEN** the two outputs are byte-identical when serialized

#### Scenario: Stable ordering

- **WHEN** a rollup contains multiple items within a producer section
- **THEN** those items appear in a deterministic order that does not vary between runs

### Requirement: Error Handling Standards

All error-producing operations MUST follow structured error handling:

- Errors MUST be wrapped with contextual information at each layer boundary (e.g., "resolving Stasis Device: expanding Cryo-Pump: unknown item ID prod999")
- Sentinel errors MUST be defined for domain-specific failure modes that callers need to distinguish programmatically — at minimum: unknown item, illegal method, cycle detected, and missing constant
- Silent error swallowing MUST NOT occur — every error MUST be either returned to the caller, logged with sufficient context, or explicitly handled with a documented reason for suppression
- Structured logging MUST be used for error reporting (key-value pairs, not string interpolation)

#### Scenario: Errors carry the resolution path

- **WHEN** graph resolution fails at a node several levels deep
- **THEN** the returned error names the chain of items from the target to the failing node

#### Scenario: Missing constant is distinguishable

- **WHEN** a Tier 2 constant required by a producer calculation is absent
- **THEN** the engine returns an error matching the missing-constant sentinel, naming the constant

#### Scenario: No partial results on failure

- **WHEN** any stage of computation returns an error
- **THEN** the engine returns no partial rollup alongside that error
