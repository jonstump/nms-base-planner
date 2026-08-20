# Generated data

`tier1.json` is the Tier 1 artifact: the recipe graph and base-economy
values extracted from a No Man's Sky install.

**It is generated and MUST NOT be hand-edited.** Per ADR-0001 it is
regenerated per game version, and per SPEC-0004 REQ "Deterministic Output"
two runs over the same install produce byte-identical output — so any diff
here is a real change in the game data, and an edit made by hand is a diff
the next regeneration silently reverts.

To regenerate, decompile an install and run the generator:

```
nmsextract extract NMSARC.Precache.pak $SRC metadata/reality/tables/
nmsextract extract NMSARC.Precache.pak $SRC metadata/simulation/scanning/
nmsextract extract NMSARC.Precache.pak $SRC language/
nmsextract extract NMSARC.Precache.pak $SRC interactiveflora/farm
nmsextract extract NMSARC.globals.pak  $SRC gcgameplayglobals
MBINCompiler <each .mbin>
go run ./cmd/nmstier1 -src $SRC -out data/tier1.json -game-version 5.97
```

`internal/normalize` has a test that does exactly this and compares the
result byte for byte with the committed file. It is gated on a real install:

```
NMS_SOURCE_DIR=$SRC go test ./internal/normalize/ -run Reproduces
```

The hand-authored fixtures under `internal/domain/testdata/` are golden
files for the engine's own tests, not the dataset.
