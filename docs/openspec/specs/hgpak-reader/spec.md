---
status: draft
date: 2026-08-17
implements: [ADR-0001]
supersedes-implementation: [internal/psarc]
---

# SPEC-0003: HGPAK Archive Reader

## Overview

Stage 1 of the ADR-0001 ingestion pipeline: turning the game's `.pak` archives into `.MBIN` files on disk that MBINCompiler can decompile. ADR-0001 assumes this step exists and says nothing about how the container is laid out — correctly, because at decision time nobody had looked.

Somebody has now looked. Every archive under `GAMEDATA/PCBANKS` is an `HGPAK` container: a zstd block stream with a fixed decompressed block size, an MD5-keyed entry table, and a path manifest stored as entry 0. This spec defines the reader for that container.

It replaces `internal/psarc`, which implements PlayStation Archive and can open no file in the game install. That package was written against an unverified label on a diagram edge and its tests validated its own writer against its own reader, so a complete green suite proved only self-consistency. The verification requirements below exist specifically so that failure mode cannot recur.

The reader's only consumer is the ingestion CLI. It is a developer-local tool, not shipped code, and per ADR-0001 it never runs in CI — which puts the burden of correctness on fixtures rather than on a pipeline.

## Requirements

### Requirement: Real-Archive Verification

The reader MUST NOT be considered implemented until it has been run against an unmodified archive from a real game install and produced files that MBINCompiler accepts.

The test suite MUST include at least one fixture derived from a real archive. A suite that exercises the reader only against archives constructed by the project's own test helpers does not satisfy this requirement, regardless of coverage.

Because a full `.pak` is far too large to commit and is Hello Games' data, the committed fixture MUST be a **structurally faithful excerpt**: a small, valid HGPAK built from a handful of real entries, carrying the real header layout, real block framing, real alignment, and real manifest formatting. The reader MUST also be exercisable against a full archive via an opt-in path (an environment variable naming a PCBANKS directory) that skips when unset.

Where a fixture is synthesized rather than excerpted, the test MUST state in a comment which real archive its structure was checked against.

#### Scenario: A real excerpt is present

- **WHEN** the test suite runs with no game install available
- **THEN** it opens the committed real-archive excerpt, lists its manifest, and extracts its entries

#### Scenario: Full-archive test is opt-in, not silently absent

- **WHEN** the environment variable naming a PCBANKS directory is set
- **THEN** the suite opens every archive in it and verifies each one's manifest and entry count
- **AND WHEN** it is unset, those tests report as skipped rather than passing

#### Scenario: Synthetic-only suites are rejected

- **WHEN** every archive a test opens was produced by the project's own helper
- **THEN** the requirement is not met, even at full statement coverage

### Requirement: Container Identification

The reader MUST verify the 8-byte magic `HGPAK\0\0\0` before interpreting any other field, and MUST reject a file whose magic does not match with an error naming the magic found.

The reader MUST reject a version field it does not implement rather than attempting a best-effort parse. Version 2 is the observed version and the one this spec covers.

All multi-byte integers in the header, entry table, and block table MUST be decoded as **little-endian unsigned 64-bit**, except the entry hash, which is an opaque 16-byte value.

#### Scenario: A PSARC file is rejected clearly

- **WHEN** a PSARC archive is opened
- **THEN** the read fails naming the magic found, and no entry table is parsed

#### Scenario: An unknown version is refused

- **WHEN** the version field holds a value this reader does not implement
- **THEN** the read fails naming the version, rather than parsing with version 2 rules

### Requirement: Structural Layout

The reader MUST parse a 0x30-byte header: the 8-byte magic, then u64 version, entry count, block count, a **storage flag** at `0x20`, and a data-start offset. In both layouts below, an entry table of `entryCount` 32-byte records begins at 0x30, each a 16-byte hash followed by a u64 offset and a u64 size.

The storage flag selects the layout. The reader MUST reject any value other than the two below rather than guessing:

| Flag | Layout |
|---|---|
| `1` | **Block stream.** The entry table is followed by a block table of `blockCount` u64 compressed lengths, then the blocks. 95 of the install's 97 archives. |
| `0` | **Stored.** The entry table is followed directly by the data — no block table. `dataStart` is exactly `0x30 + entryCount * 32`, entry offsets are direct file offsets, and entry bytes including the manifest sit uncompressed. Observed in `NMSARC.audio.pak` and `NMSARC.audioBNK.pak`, whose WEM/BNK payloads are already compressed, so a second pass would buy nothing. |

For a block-stream archive, each block MUST be decompressed with zstd and MUST yield exactly 65,536 bytes, except the final block, which MAY be shorter. A block that decompresses to a different length MUST be treated as a malformed archive.

A block whose **compressed length is exactly 65,536** MUST be treated as stored verbatim and MUST NOT be passed to the decompressor. This is a length rule decided before any decompression is attempted, not a magic sniff and not a fallback: the packer stores a block when compressing it would not pay, and the stored length then equals the decompressed length by definition. A block of any other length that fails to decompress MUST remain a malformed archive — the reader MUST NOT fall back to raw bytes on decompression failure, which is the PSARC behaviour this format makes unnecessary. Observed in `NMSARC.UI.pak` and the `TexBiomes*` family.

Blocks MUST be located by accumulating compressed lengths from the header's data-start offset, advancing to the next **16-byte boundary** after each block. Omitting the alignment step causes the second block to fail to decompress.

Entry offsets MUST be interpreted as positions in a **virtual image of the file** whose first `dataStart` bytes are the header and tables. The position of an entry within the concatenated decompressed stream is therefore `entry.offset - dataStart`.

Entry sizes, block lengths, and the table counts are all read from the file and are otherwise unbounded. The reader MUST bound each against the bytes actually remaining **before** allocating for it, and MUST NOT perform that check by computing a sum or a signed conversion that can overflow. A malformed archive MUST surface as a malformed-archive error naming the structure at fault; it MUST NOT panic.

#### Scenario: Both storage layouts are read

- **WHEN** an archive with storage flag `0` is opened
- **THEN** its entries resolve by direct file offset with no block table parsed
- **AND WHEN** the flag holds any value other than `0` or `1`
- **THEN** the read fails naming the value found

#### Scenario: A verbatim block is not decompressed

- **WHEN** a block's compressed length is exactly 65,536
- **THEN** its bytes are taken as-is, and no decompression is attempted on it

#### Scenario: An oversized extent is refused, not fatal

- **WHEN** an entry size or block length is large enough that adding it to a position would overflow
- **THEN** the read fails as a malformed archive naming the entry or block, rather than panicking on an oversized allocation

#### Scenario: Block alignment is honoured

- **WHEN** an archive with more than one block is read
- **THEN** every block decompresses successfully, and the total decompressed length equals the block count times 65,536 less any short final block

#### Scenario: Virtual offsets resolve correctly

- **WHEN** the first entry of an archive is read
- **THEN** it resolves to stream position zero, not to position `dataStart`

#### Scenario: A truncated archive is refused

- **WHEN** an entry's extent runs past the end of the decompressed stream
- **THEN** the read fails naming the entry, rather than returning a short buffer

### Requirement: Manifest and Path Resolution

The reader MUST treat entry 0 as the path manifest: a byte blob of **CRLF-separated** lowercase paths. Manifest entry *n* names archive entry *n*, so the manifest MUST hold exactly `entryCount - 1` non-empty paths.

The reader MUST expose every entry by its path. It MUST NOT require the caller to supply a hash, and MUST NOT depend on any external hash-to-name mapping.

The reader MUST verify that an entry's 16-byte hash equals the **MD5 of its lowercase path**, and MUST report a mismatch as a malformed archive rather than silently preferring one of the two.

A manifest whose path count disagrees with `entryCount - 1` MUST be reported as malformed.

#### Scenario: Paths come from the archive alone

- **WHEN** an archive is opened with no external data available
- **THEN** every entry is listed by its full path

#### Scenario: Manifest count is checked

- **WHEN** the manifest holds a number of paths other than `entryCount - 1`
- **THEN** the read fails naming both counts

#### Scenario: Hash and path agree

- **WHEN** each entry's path is hashed with MD5
- **THEN** the digest equals the entry's stored hash, and any mismatch fails the read

### Requirement: Selective Extraction

Because block size is fixed at 65,536 decompressed bytes, an entry at stream position `P` begins in block `P / 65536`. The reader MUST use this to decompress only the blocks covering a requested entry, and MUST NOT decompress the whole archive to read one file.

The reader MUST expose listing without extraction, so that a caller can enumerate an archive's paths having decompressed only the blocks covering the manifest.

Entry contents MUST be read on demand rather than at open. `NMSARC.MetadataEtc.pak` decompresses to roughly 565 MB, which MUST NOT be required resident to read one table.

#### Scenario: Listing is cheap

- **WHEN** the paths of a 47,000-entry archive are listed
- **THEN** only the blocks covering the manifest were decompressed

#### Scenario: One entry costs its own blocks

- **WHEN** a single 26 KB entry is extracted from a 47 MB archive
- **THEN** only the blocks spanning that entry were decompressed

### Requirement: Safe Extraction to Disk

Archive paths are untrusted input. When extracting to a directory, the reader MUST reject any entry whose resolved destination falls outside that directory — including absolute paths, paths containing `..`, and paths that traverse a symlink out of the tree.

A rejected path MUST fail the extraction with an error naming the offending path. The reader MUST NOT silently skip it.

The reader MUST create parent directories as needed, and MUST tolerate a leading separator on an archive path by treating it as relative.

#### Scenario: Traversal is refused

- **WHEN** an entry's path escapes the output directory
- **THEN** extraction fails naming that path, and nothing is written outside the directory

#### Scenario: Nested paths are created

- **WHEN** an entry at `metadata/reality/tables/costtable.mbin` is extracted
- **THEN** the intermediate directories are created and the file lands at the mirrored path

### Requirement: Pipeline Fitness

Extraction MUST produce byte-exact entry contents — the reader performs no transformation on entry bytes beyond decompression of the containing blocks.

The CLI MUST support filtering by path substring on both listing and extraction, since a single archive holds tens of thousands of entries.

Extraction of `metadata/reality/tables/` from `NMSARC.Precache.pak` MUST yield files beginning with MBIN magic `cccccccc` that MBINCompiler decompiles without error. This is the acceptance test for the whole stage.

#### Scenario: The tables extract and decompile

- **WHEN** `metadata/reality/tables/` is extracted from `NMSARC.Precache.pak`
- **THEN** all 54 tables are written, each begins with `cccccccc`, and MBINCompiler decompiles `nms_reality_gcproducttable.mbin` to EXML without error

#### Scenario: Filtering narrows a large archive

- **WHEN** a 47,000-entry archive is listed with a path filter
- **THEN** only matching paths are printed, and the count of matches is reported

### Requirement: Error Handling Standards

All error-producing operations MUST follow structured error handling:

- Errors MUST be wrapped with contextual information at each layer boundary (e.g., "reading entry metadata/reality/tables/costtable.mbin: block 42 decompressed to 32768 bytes, want 65536")
- Sentinel errors MUST be defined for domain-specific failure modes that callers need to distinguish programmatically — at minimum: not an HGPAK archive, unsupported version, malformed archive, entry not found, and unsafe extraction path
- Silent error swallowing MUST NOT occur — every error MUST be either returned to the caller, logged with sufficient context, or explicitly handled with a documented reason for suppression
- Structured logging MUST be used for error reporting (key-value pairs, not string interpolation)

#### Scenario: A wrong-format file is distinguishable from a corrupt one

- **WHEN** a caller opens a PSARC file, versus an HGPAK whose blocks will not decompress
- **THEN** the two failures carry different sentinels

#### Scenario: Failures name the entry

- **WHEN** extraction fails on one entry of many
- **THEN** the error names that entry's path and the structural expectation that was violated
