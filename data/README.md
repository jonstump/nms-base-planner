# Data artifacts

Two files, with opposite rules. `tier1.json` is generated and must not be
edited; `tier2.json` is hand-maintained and editing it is the point.

## tier1.json — generated

`tier1.json` is the Tier 1 artifact: the recipe graph and base-economy
values extracted from a No Man's Sky install.

**It is generated and MUST NOT be hand-edited.** Per ADR-0001 it is
regenerated per game version, and per SPEC-0004 REQ "Deterministic Output"
two runs over the same install produce byte-identical output — so any diff
here is a real change in the game data, and an edit made by hand is a diff
the next regeneration silently reverts.

To regenerate, decompile an install and run the generator:

```
nmsextract extract NMSARC.Precache.pak    $SRC metadata/reality/tables/
nmsextract extract NMSARC.Precache.pak    $SRC metadata/simulation/scanning/
nmsextract extract NMSARC.Precache.pak    $SRC plantinteraction.entity
nmsextract extract NMSARC.globals.pak     $SRC gcgameplayglobals.global
nmsextract extract NMSARC.MetadataEtc.pak $SRC _english.mbin
MBINCompiler <each .mbin>
go run ./cmd/nmstier1 -src $SRC -out data/tier1.json -game-version 5.97
```

Three archives, not two. The localisation tables that supply every display
name live in `NMSARC.MetadataEtc.pak` — a different archive from the recipe
tables, which is easy to miss because nothing else about the pipeline
suggests it. `language/` is absent from `NMSARC.Precache.pak` entirely, so
extracting it from there yields nothing and the generator fails on the
missing glob rather than producing a nameless graph.

`tier1.json`'s own `provenance.archives` records all three, and that field
is what this procedure has to stay consistent with.

`internal/normalize` has a test that does exactly this and compares the
result byte for byte with the committed file. It is gated on a real install:

```
NMS_SOURCE_DIR=$SRC go test ./internal/normalize/ -run Reproduces
```

The hand-authored fixtures under `internal/domain/testdata/` are golden
files for the engine's own tests, not the dataset.

## tier2.json — hand-maintained

`tier2.json` is the Tier 2 curated set: the base-economy constants that are
genuinely *not* in the game files, plus the ones that are planner policy
rather than game data at all. Per ADR-0001 it is **hand-maintained**, so
unlike `tier1.json` editing it is the intended way to change it.

ADR-0001 specifies a YAML file. This ships JSON instead, for two reasons
that are about delivery rather than the decision: the browser fetches it
directly, so JSON needs no build-time conversion step, and Go has no YAML
parser in its standard library, so the alternative adds a dependency to the
module for a file the module never reads. The per-entry `source` and
`verified` fields ADR-0001 actually asks for are all present. If the file
grows to the point where the comments matter more than the tooling, YAML
plus a conversion step in `build-wasm.sh` is the way back.

It carries seven scalars, two classification maps, and a `verified` date per
scalar. **`verified: null` is meaningful, not missing metadata**: the engine
reads a constant with no verified date as unverified and taints every figure
derived from it, so today every producer row renders with the unverified
badge. Confirming a constant in game and writing the date here is what
switches that off — for that constant, and only for the figures that rest
on it.

`web/src/boundary/curated.ts` fetches and validates it. A value that is not
a whole count above zero fails there, naming the field, rather than reaching
the engine and coming back as `MISSING_CONSTANT` on the first rollup.

`scripts/build-wasm.sh` copies it to `web/public/tier2.json` beside the Tier
1 artifact. The copy is build output and is gitignored; this file is the
source and is committed.
