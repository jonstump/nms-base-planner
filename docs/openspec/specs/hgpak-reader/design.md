# Design: HGPAK Archive Reader

## Context

ADR-0001 chose direct extraction from the maintainer's own game install, with a Go CLI unpacking `.pak` archives and MBINCompiler decompiling the `.MBIN` files that come out. The decompile half is settled — MBINCompiler ships Linux binaries and runs as a subprocess. The unpack half had no spec, and the code written for it targets the wrong format.

Four facts from parsing real archives shape this design:

- **The container is HGPAK, not PSARC.** Verified across all 97 archives in the install. `internal/psarc` opens none of them. The provenance of that mistake is recorded in ADR-0001 and is the reason this spec leads with a verification requirement rather than a format requirement.
- **Blocks decompress to a fixed 65,536 bytes.** This is the single most useful property in the format: it makes stream position to block index pure arithmetic, so random access needs no index beyond the block table already present.
- **Entry 0 is a plaintext manifest.** Names are recoverable from the archive alone. An earlier reading of the header suggested MD5-keyed lookup with no path table, which would have made extraction depend on a community-maintained hash list; that reading was wrong, and the difference is the difference between a viable pipeline and a blocked one.
- **`NMSARC.MetadataEtc.pak` does not contain the metadata tables.** They are in `NMSARC.Precache.pak`. The obvious-sounding archive is the wrong one, which is worth stating in writing because it will otherwise be rediscovered.

## Goals / Non-Goals

### Goals

- Extract the ADR-0001 Tier 1 inputs from a real install, in a form MBINCompiler accepts
- Make correctness contingent on real archives, so a green suite means the reader works
- Keep memory bounded — read one 26 KB table without materializing 565 MB
- Fail loudly and specifically on structural surprise, since the format is reverse-engineered and future game updates will change it
- Stay stdlib-only apart from zstd, matching the project's current dependency posture

### Non-Goals

- **Writing HGPAK archives.** Nothing in the pipeline creates one. A writer exists only if fixture construction demands it, and if it does, it is a test helper and never the thing under test.
- **Decoding MBIN.** ADR-0001 explicitly rejected reimplementing libMBIN. The reader hands bytes to MBINCompiler.
- **Supporting historical PSARC archives.** Old installs are not a use case; the maintainer extracts from the version being played.
- **Normalization, graph building, provenance.** Downstream, separate spec.
- **Running in CI.** ADR-0001 already records ingestion as developer-local. The opt-in full-archive test is the concession to that.

## Decisions

### Verification requirement before format requirement

**Choice**: The spec's first requirement is that the reader has been run against a real archive, and that a real-archive excerpt is committed as a fixture. Format structure comes second.

**Rationale**: The failure this replaces was not a misread of the format — it was 996 lines of correct, well-tested PSARC code for a project that has no PSARC files. Coverage was 86.7% and every test passed, because `buildArchive()` wrote the same format the reader read. Ordering the requirements this way makes the reviewable question "what real file did this open?" rather than "do the tests pass?".

**Alternatives considered**: Requiring a full archive as a fixture — rejected, since the smallest is 646 KB and it is Hello Games' data. Trusting an opt-in environment-gated test alone — rejected, because a test that skips by default is a test that is not running, which is how the original gap persisted through review.

### A structurally faithful excerpt as the committed fixture

**Choice**: Commit a small valid HGPAK assembled from a few real entries, preserving real header layout, block framing, alignment, and manifest formatting. Pair it with an opt-in test against the full PCBANKS directory.

**Rationale**: This is the smallest artifact that still fails when an assumption is wrong. The two bugs most likely to recur — forgetting 16-byte block alignment, and treating entry offsets as stream-relative — both survive any synthetic fixture built from the same misunderstanding, and both are caught by an excerpt that carries real framing across a block boundary. The fixture must therefore span at least two blocks to be worth committing.

**Trade-off**: It contains a small amount of real game data. Kept to the structural minimum, and it is game data rather than player data, which ADR-0001 already treats as committable.

### On-demand block decompression, no whole-archive materialization

**Choice**: Open parses the header, entry table, block table, and manifest only. Entry reads decompress just the blocks spanning the entry, computed as `pos / 65536`.

**Rationale**: The fixed decompressed block size makes this trivial, and the sizes force it — MetadataEtc decompresses to ~565 MB and Precache is the archive we actually need repeatedly. Listing an archive costs only the manifest's blocks.

**Trade-off**: A caller extracting every entry in path order re-decompresses shared blocks. Acceptable: extraction is a rare developer-local operation, and a small LRU over recent blocks recovers most of it if it ever matters. Not specified, because measuring first is cheaper than guessing.

### Hash verification as a structural check, not a lookup mechanism

**Choice**: Resolve entries by path from the manifest. Verify that MD5 of the lowercase path matches the stored hash, and fail on mismatch.

**Rationale**: The hash is redundant with the manifest, which makes it a free consistency check on the two structures agreeing — and a cheap early warning that a future game update changed the convention. Using the hash *as* the lookup key would be reintroducing a dependency the manifest removes.

**Trade-off**: MD5 over every path at open. Negligible against the zstd work already done, and it can move behind a flag if a 47,000-entry archive ever shows it.

### Fail closed on structural surprise

**Choice**: Wrong magic, unknown version, wrong decompressed block length, manifest count mismatch, hash mismatch, and out-of-range entry extent all fail the read with distinct sentinels. No best-effort parsing.

**Rationale**: The format is reverse-engineered from one game version, and ADR-0001 already accepts that a game update can invalidate the pipeline. The useful behaviour on a changed format is a precise error naming what moved, not a partial extract that silently produces wrong Tier 1 data — which would surface much later as a wrong recipe tree, with no obvious cause.

**Contrast with the superseded reader**: `internal/psarc` deliberately fell back to raw bytes when a block failed to inflate, because PSARC does not mark blocks as compressed. HGPAK's fixed decompressed size means a failed decompression is unambiguous evidence of a wrong assumption, so the same tolerance would be a bug here.

HGPAK does store some blocks verbatim, but it identifies them by **length, not by sniffing**: a compressed length of exactly 65,536 means stored, because the packer skips compression when it would not pay and the stored length then equals the decompressed length by definition. That rule is decided before any decompression is attempted, so it does not reintroduce inflate-and-fall-back. A block of any other length that fails to decompress remains a hard `ErrMalformed`.

### zstd as the one external dependency

**Choice**: Take a pure-Go zstd decoder as a module dependency. The project is currently stdlib-only.

**Rationale**: There is no `compress/zstd` in the standard library, and the format leaves no alternative — every block in every archive is zstd. A pure-Go decoder keeps `go test` and the WASM build free of cgo. Shelling out to the `zstd` binary is possible and is what the exploratory prototype did, but a per-block subprocess is untenable for 8,628 blocks and would put a system binary in the pipeline's dependency set.

**Scope note**: The dependency belongs to the ingestion CLI, not the domain core. ADR-0003 keeps the domain package free of anything the browser cannot run, and nothing in `internal/domain` imports this reader.

## Risks / Trade-offs

- **A game update changes the container.** Likely eventually; version 2 is already the second. Mitigated by failing loudly on version and structure, so the next change presents as a named error rather than corrupt output.
- **The excerpt fixture drifts from the shipping format.** A fixture built today keeps passing after the game changes. The opt-in full-archive test is the counterweight, and running it is part of re-extracting after a game update — which ADR-0001 already establishes as a manual step.
- **The header field at 0x20 — resolved; it is a storage flag.** This entry previously read "observed as 1 in every archive examined, parsed and ignored". That held for the two archives parsed when it was written and broke on the first run across all 97: it is `1` for a zstd block stream and `0` for stored archives (`NMSARC.audio.pak`, `NMSARC.audioBNK.pak`). The reader now validates it and rejects any third value. Kept in this list rather than deleted, because the mitigation this risk asked for — assert on the field instead of silently discarding it — is exactly what surfaced the answer.
- **Only one game version has been examined.** Every structural claim in the spec comes from a single NMS 5.97 install, whose pak files span 2026-05-04 to 2026-06-16 (the game patches incrementally, rewriting only changed archives). The claims are stated as observations with the archives that produced them, so a future reader can tell measurement from assumption — which is exactly what the PSARC label failed to do.

## Migration Plan

1. Land the reader and its fixtures alongside `internal/psarc`, which stays untouched and unreferenced.
2. Point `cmd/nmsextract` at the new reader.
3. Run the acceptance test — extract `metadata/reality/tables/` from `NMSARC.Precache.pak` and decompile the product table with MBINCompiler.
4. Delete `internal/psarc` in the same PR that proves the replacement works. It has no other consumer and no value as reference; keeping it invites the next reader to assume it means something.

## Open Questions

- Does a small block cache measurably help bulk extraction, or is the re-decompression cost noise against MBINCompiler subprocess time?
- Where does `blockCount` point for a stored archive? It is non-zero (1017 for `NMSARC.audioBNK.pak`) but no block table exists between the entry table and the data. Unchased: nothing in the ADR-0001 pipeline needs it.
- Is a stored *final* block distinguishable from a compressed one? For the last block the compressed length equals the decompressed length either way, so the `== 65,536` rule cannot separate them. No archive in the install exhibits it, so it is unhandled rather than speculatively coded.

**Answered by the full-archive run** (all 97 archives, story #9):

- ~~Is the 0x20 header field a flags word, an alignment hint, or a compression-method selector?~~ A storage selector — see the resolved risk above.
- ~~Do any archives use a compression method other than zstd, or a block size other than 65,536?~~ No. Block size is 65,536 everywhere and zstd is the only compression used. Two storage variants exist that the spec did not describe — stored archives and verbatim blocks — and both are identified structurally rather than by sniffing.
