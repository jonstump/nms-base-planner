---
status: draft
date: 2026-08-18
implements: [ADR-0001]
requires: [SPEC-0001, SPEC-0003]
---

# SPEC-0004: Tier 1 Normalizer

## Overview

The stage between decompiled game tables and the artifact the app consumes. SPEC-0003 unpacks `.pak` archives to `.MBIN`; MBINCompiler converts those to `.MXML`; SPEC-0001's rollup engine loads a `Tier1` artifact and resolves dependency graphs from it. Nothing currently connects the two ends — this spec covers the normalizer that does.

The output format is not speculative. `internal/domain.Tier1` already exists, `LoadTier1` already validates it, and `testdata/stasis-device.tier1.json` is a hand-authored fixture in exactly that shape that the merged rollup engine resolves today. Those fixtures carry `extracted: false` precisely to mark that a real producer had not been built. This spec is that producer, and the fixtures become golden files to diff against.

Scope changed materially on 2026-08-18. ADR-0001 planned a five-constant hand-curated Tier 2; confirmation against real values found four of the five extractable (per-part rates and storage, C/B/A/S hotspot class strengths, crop yields, crop growth times). The normalizer therefore emits base-economy data as well as the recipe graph, and the `Tier1` schema has to grow to hold it.

## Requirements

### Requirement: Source Provenance and Version Stamping

Every emitted artifact MUST record what produced it. The artifact MUST set `extracted` to `true`, MUST record the game build it was derived from in `game_version`, and MUST record the source archives and MBINCompiler version in `source`.

The normalizer MUST NOT emit an artifact that claims a `game_version` it did not read from the install. Where a game version string cannot be determined, the read MUST fail rather than emit a guess or a placeholder.

Artifacts are regenerated per game version and MUST NOT be hand-edited. The normalizer MUST be able to reproduce any committed artifact from the same install without manual steps.

#### Scenario: Provenance is recorded

- **WHEN** an artifact is generated from a real install
- **THEN** `extracted` is `true`, `game_version` names the build read, and `source` names the archives and the MBINCompiler version used

#### Scenario: Unknown game version fails rather than guesses

- **WHEN** the game version cannot be determined from the install
- **THEN** generation fails naming what could not be read, and no artifact is written

### Requirement: Deterministic Output

Running the normalizer twice against the same install MUST produce byte-identical output. Collections MUST be emitted in a defined, stable order — not in map-iteration order, and not in the order entries happen to appear in a decompiled table.

This is a correctness requirement rather than an aesthetic one: the artifact is committed to the repository, so nondeterministic output turns every regeneration into an unreviewable diff and hides real changes among spurious ones.

#### Scenario: Regeneration is a no-op diff

- **WHEN** the normalizer runs twice against an unchanged install
- **THEN** the two artifacts are byte-identical and `git diff` reports no change

#### Scenario: A real change is legible

- **WHEN** the game updates and one recipe's quantity changes
- **THEN** the artifact diff shows that change and no unrelated reordering

### Requirement: Recipe Graph Construction

The normalizer MUST build `items` and `recipes` from the reality tables — products, substances, and the refinery and cooking recipe tables.

Every recipe's `method` MUST be one of `craft`, `refine`, `raw`, or `cook`. The normalizer MUST NOT emit a `buy` method; per SPEC-0001 REQ "Method Resolution" that value is deliberately absent from the vocabulary and this is a build planner, not a shopping list.

Every `Input.item` and every `Recipe.output` MUST reference an `Item.id` present in the same artifact. An input referencing an unknown item MUST fail generation rather than emit a dangling edge.

Items with no recipe MUST be emitted with `raw_obtainable` true and `default_method` `raw`, so the rollup engine's terminal-node handling has the leaves it expects.

**Raw-obtainability MUST be read from the source, not inferred from the absence of a recipe.** Having a recipe and being gatherable are independent: you mine Cobalt with a terrain manipulator *and* you can refine it. Deriving `raw_obtainable` from "has no recipe" therefore marks every gatherable substance as non-raw the moment the game gives it a refine route, and the item defaults to `refine`. Because refining runs both ways between several such pairs — `CAVE1 ⇄ CAVE2`, `CATALYST1 ⇄ CATALYST2`, `GAS1 → GAS3 → GAS2 → GAS1` — the resulting graph is not resolvable: 571 of 2,237 items hit a cycle under pure defaults.

The substance table states gatherability in `PinObjective`, the pinned objective shown for the item. Six substances read `UI_REFINE_OBJ` and are refined only; the other 105 read some flavour of gather, find or process. The normalizer MUST set `raw_obtainable` true for every substance whose `PinObjective` is not `UI_REFINE_OBJ`, and MUST fail rather than guess where the field is absent or holds a value that list does not cover.

The product table carries no equivalent field, so a product that has a recipe MUST NOT be marked raw-obtainable. A product with no recipe still is, by the rule above — that is what gives the engine a leaf rather than an item it cannot terminate on.

A raw-obtainable item MUST default to `raw` even where it also has recipes. Gathering is the route a player takes by default, expanding it is what produces the cycles above, and the engine's per-node method override exists precisely so a player who wants the refine route can take it.

**Every recipe the source defines MUST be emitted.** Per ADR-0005 the artifact carries a list of recipes per output and method, not one: 261 of 403 refiner output/method pairs have more than one route, up to 61 for a single item. The normalizer MUST NOT select, deduplicate, or otherwise discard alternatives — selection is the engine's job and depends on expansion the normalizer does not perform.

**Each recipe's yield MUST be read from the source.** 156 of 1,681 refiner recipes produce a quantity other than one, up to 250. A yield MUST NOT default silently to one; where the source does not state it, generation MUST fail rather than assume.

**Refining and cooking come from one table.** The refiner table carries both, distinguished by a per-recipe `Cooking` flag: true yields method `cook`, false yields `refine`. The normalizer MUST read that flag rather than inferring the method from the recipe's contents.

**Self-referential recipes MUST be excluded, and the count recorded.** A recipe naming its own output among its ingredients — `1x Phosphorus + 1x Solanium -> 2x Solanium` — is a doubling strategy rather than a production path, and expanding it is a cycle. There are 27. The normalizer MUST omit them and MUST record how many it omitted in the artifact's provenance, so a change in that number is visible rather than silent.

#### Scenario: Alternatives are all emitted

- **WHEN** the source defines 26 refine recipes producing `CATALYST2`
- **THEN** the artifact carries all 26, and the normalizer selects none of them
#### Scenario: Gatherability comes from the source

- **WHEN** a substance's `PinObjective` is `UI_GATHER_REFINE_OBJ` and the table also defines refine recipes for it
- **THEN** it is emitted `raw_obtainable` true with `default_method` `raw`, and its refine recipes are emitted alongside

#### Scenario: A refine-only substance is not raw

- **WHEN** a substance's `PinObjective` is `UI_REFINE_OBJ`
- **THEN** it is emitted `raw_obtainable` false, defaulting to `refine`

#### Scenario: The generated graph resolves

- **WHEN** the rollup engine resolves each item in a generated artifact under default methods
- **THEN** every item resolves, and none reports a cycle


#### Scenario: Yields survive

- **WHEN** a recipe producing 50 units from one input is read
- **THEN** its yield is 50 in the artifact, not 1

#### Scenario: An absent yield fails rather than defaults

- **WHEN** a recipe's output quantity cannot be read from the source
- **THEN** generation fails naming the recipe, rather than assuming a yield of one

#### Scenario: Cooking is distinguished by its flag

- **WHEN** a refiner recipe carries `Cooking` true
- **THEN** its method is `cook`, and a recipe carrying `Cooking` false is `refine`

#### Scenario: Self-referential recipes are excluded and counted

- **WHEN** a recipe names its own output among its ingredients
- **THEN** it is omitted from the artifact, and the provenance records the omitted count

#### Scenario: The graph is closed

- **WHEN** an artifact is generated
- **THEN** every recipe input and output resolves to an item in the same artifact

#### Scenario: A dangling reference fails generation

- **WHEN** a recipe references an item ID absent from the tables
- **THEN** generation fails naming the recipe and the missing ID, and no artifact is written

#### Scenario: The method vocabulary is closed

- **WHEN** a source table implies a method outside craft, refine, raw, cook
- **THEN** generation fails naming the method found, rather than emitting it

### Requirement: Identifier Policy

Item identifiers in the artifact MUST be the game's own IDs (`ULTRAPROD2`, `PLANT_SNOW`, `U_EXTRACTOR_S`), not invented short codes.

Game IDs are stable across builds, are what save files carry, and are what ADR-0002's save-import joins against; a bespoke ID scheme would have to be re-derived and re-verified on every regeneration. The existing fixtures use short codes (`fc`, `sb`) because they were hand-authored before extraction existed, and MUST be treated as illustrative of shape rather than of identifier policy.

The normalizer MUST NOT normalize, case-fold, or otherwise rewrite game IDs.

#### Scenario: Game IDs survive verbatim

- **WHEN** the Stasis Device is emitted
- **THEN** its item ID is `ULTRAPROD2`, exactly as the product table spells it

### Requirement: Display Name Resolution

Item names MUST be resolved to human-readable English via the localisation tables. The reality tables carry only localisation *keys* — `NameLower` on the Stasis Device is `UI_ULTRAPROD_2_NAME_L`, not "Stasis Device" — and those keys resolve in `language/nms_loc*_english.mbin`, which lives in a different archive from the product table.

Where a name key does not resolve, the normalizer MUST fail generation naming the key and the item, rather than falling back to the raw key or to the ID. An artifact full of `UI_ULTRAPROD_2_NAME_L` is worse than no artifact, because it looks like data.

#### Scenario: Names come from the localisation tables

- **WHEN** `ULTRAPROD2` is emitted
- **THEN** its `name` is "Stasis Device", resolved through `UI_ULTRAPROD_2_NAME_L`

#### Scenario: An unresolved key fails rather than leaks

- **WHEN** an item's name key is absent from the localisation tables
- **THEN** generation fails naming the key and the item, and no artifact is written

### Requirement: Base Economy Data

The artifact MUST carry the base-economy values confirmed extractable on 2026-08-18, so they are version-stamped and regenerated rather than hand-curated:

- Per-part production and consumption **rates** and **storage** buffers, from `GcBaseLinkGridData`, together with the network each applies to and any dependent-connection rate
- **Hotspot class strengths and weightings** for C/B/A/S per hotspot category, from `REGIONHOTSPOTSTABLE`
- **Crop yields**, from the reward table's minimum and maximum amounts — under `GcRewardSpecificSubstance` or `GcRewardSpecificProduct`, whichever the entry carries
- **Crop growth times**, from the plant's `PlantGrowth` connection storage value
- **Refiner throughput**, from `gcgameplayglobals`, including the difficulty variants

Class scaling MUST be modelled as a property of the hotspot, not of the device. A part declares a base rate and a hotspot dependency; the class belongs to the hotspot. The normalizer MUST NOT emit per-class device variants, which do not exist in the source data.

Yields and class strengths that the source expresses as a minimum and a maximum MUST be preserved as a range. Collapsing a range to a single value discards information the planner needs to show best and worst case.

**A crop's reward may be a product rather than a substance.** Eight of the twelve farmable plants hand back a substance under `GcRewardSpecificSubstance`; the other four — venom sacs, gravitino balls, nip-nip buds and albumen pearls — hand back a product under `GcRewardSpecificProduct`, which carries an identical `AmountMin`/`AmountMax` shape. The normalizer MUST read both forms. Reading only the substance form silently drops four of twelve crops, which is a smaller artifact that still loads.

**A crop's reward key is not its substance.** The reward table is keyed by the plant's interaction id, and the item it yields is named inside the entry: `PLANT_BARREN` yields `PLANT_DUST`. The normalizer MUST take the yielded item from the reward's own `ID` rather than from the key it looked the reward up by. The two agree for eleven of twelve crops, which is what makes assuming they always agree dangerous.

#### Scenario: Rates carry their network

- **WHEN** `U_EXTRACTOR_S` is emitted
- **THEN** its rate, its storage, and its dependent power draw are present, each identified by the network it applies to

#### Scenario: Class scaling attaches to hotspots

- **WHEN** class strengths are emitted
- **THEN** they are keyed by hotspot category and class, and no per-class device variants appear

#### Scenario: Ranges survive as ranges

- **WHEN** a crop yield is expressed as a minimum and maximum in the source
- **THEN** both bounds are emitted, rather than one derived value

#### Scenario: A crop yielding a product is emitted

- **WHEN** a plant's reward entry carries `GcRewardSpecificProduct` rather than `GcRewardSpecificSubstance`
- **THEN** the crop is emitted with that product as its yielded item, rather than omitted

#### Scenario: The yielded item comes from the reward, not the key

- **WHEN** a plant's reward entry is keyed `PLANT_BARREN` and names `PLANT_DUST` inside
- **THEN** the emitted crop yields `PLANT_DUST`

### Requirement: Schema Extension and Load Compatibility

The `Tier1` schema MUST be extended to hold the base-economy data, and `SchemaVersion` MUST be incremented in the same change.

`LoadTier1` decodes with unknown fields disallowed, so an artifact carrying sections the struct does not declare fails to load. The producer, the schema, and the loader MUST therefore change together; the normalizer MUST NOT emit a section that `internal/domain` cannot decode.

Existing fixtures MUST continue to load. Where the extension makes a previously-valid artifact invalid, the fixtures MUST be migrated in the same change rather than left broken.

#### Scenario: New sections load

- **WHEN** an artifact carrying base-economy sections is passed to `LoadTier1`
- **THEN** it decodes without an unknown-field error and validates

#### Scenario: Existing fixtures still load

- **WHEN** the committed fixtures are loaded after the schema extension
- **THEN** they decode and validate, having been migrated if the extension required it

### Requirement: Excluded Content

The normalizer MUST take structure and quantities only. In-game `Description`, `Subtitle`, and `Hint` text, and icon or model asset paths, MUST NOT appear in the artifact.

Per ADR-0001 this is Hello Games' creative expression, and the design bundle's own rule is that no game assets or trade dress are used. Item names are retained because they are the identifiers a user reads; descriptive prose is not.

#### Scenario: Description text is excluded

- **WHEN** an item whose source record carries `Description`, `Subtitle`, and `Hint` is emitted
- **THEN** none of those fields appear anywhere in the artifact

#### Scenario: Asset paths are excluded

- **WHEN** an item whose source record names icon and model files is emitted
- **THEN** no asset path appears in the artifact

### Requirement: Structural Surprise Fails Loudly

Where a source table's structure does not match what the normalizer expects — a missing field, an unrecognized enum value, a table absent from the archive — generation MUST fail naming the table and the expectation violated.

The normalizer MUST NOT emit a partial artifact, silently skip an unparseable row, or substitute a default for a value it could not read. A game update that moves a field is the expected cause, and it MUST present as a precise error rather than as a quietly smaller recipe graph that surfaces much later as a wrong tree.

#### Scenario: A moved field is named

- **WHEN** an expected field is absent from a source table
- **THEN** generation fails naming the table and the field, and no artifact is written

#### Scenario: Partial output is never emitted

- **WHEN** generation fails partway through
- **THEN** no artifact file is left behind

### Requirement: Search Boundaries Are Recorded

Where the normalizer derives a value by searching for it rather than by reading a known field, the artifact or its generation log MUST record which sources were searched.

This project has three recorded instances of a bounded search reported as a general result — the `PSARC` diagram edge, "an unknown field (1 in every archive observed)", and the Tier 2 constants declared absent while four of five were present. A derived value that does not say what was examined cannot be distinguished later from one that was read directly.

#### Scenario: A derived value carries its provenance

- **WHEN** a value is produced by searching several tables rather than reading one known field
- **THEN** the sources searched are recorded alongside it

### Requirement: Acceptance Against the Golden Tree

The normalizer is correct when the artifact it produces reproduces ADR-0001's confirmation criteria through the merged rollup engine, rooted at `ULTRAPROD2`:

- 34 distinct nodes across the Quantum Processor (`MEGAPROD2`), Cryogenic Chamber (`MEGAPROD3`), and Iridesite (`ALLOY8`) branches
- Each gas product costing 250 gas and 50 Condensed Carbon
- At quantity ×1: 500 each of Sulphurine, Nitrogen and Radon, and 300 Condensed Carbon

This acceptance MUST run against a generated artifact, not against the hand-authored fixtures. A test that only exercises the fixtures verifies the engine, not the normalizer.

#### Scenario: The generated artifact reproduces the tree

- **WHEN** the rollup engine resolves `ULTRAPROD2` at quantity 1 from a generated artifact
- **THEN** it returns 34 distinct nodes and leaf totals of 500 Sulphurine, 500 Nitrogen, 500 Radon and 300 Condensed Carbon

#### Scenario: Acceptance uses generated output

- **WHEN** the acceptance test runs
- **THEN** its input was produced by the normalizer in that run, not read from a committed fixture

### Requirement: Error Handling Standards

All error-producing operations MUST follow structured error handling:

- Errors MUST be wrapped with contextual information at each layer boundary (e.g., "normalizing nms_reality_gcproducttable: item ULTRAPROD2: name key UI_ULTRAPROD_2_NAME_L not found in localisation tables")
- Sentinel errors MUST be defined for domain-specific failure modes that callers need to distinguish programmatically — at minimum: source table missing, structure unrecognized, reference unresolved, and localisation key unresolved
- Silent error swallowing MUST NOT occur — every error MUST be either returned to the caller, logged with sufficient context, or explicitly handled with a documented reason for suppression
- Structured logging MUST be used for error reporting (key-value pairs, not string interpolation)

#### Scenario: A failure names its table and its row

- **WHEN** normalization fails on one row of one table
- **THEN** the error names the table, the row's identifier, and the expectation violated

#### Scenario: Failure modes are distinguishable

- **WHEN** a caller encounters a missing source table versus an unresolved localisation key
- **THEN** the two failures carry different sentinels
