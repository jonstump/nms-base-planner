# hgpak test fixtures

## `excerpt.pak`

A **real-archive excerpt**, not a synthetic fixture. Required by SPEC-0003
REQ "Real-Archive Verification": a suite that only exercises the reader
against archives built by the project's own helpers does not satisfy that
requirement at any coverage level.

- **Source**: `NMSARC.globals.pak` from a real No Man's Sky install, game
  files dated 2026-06-05.
- **Contents**: the 27 smallest entries of that archive — verbatim bytes and
  verbatim paths — plus a regenerated manifest. Smallest-first so the fixture
  stays close to the two-block minimum; it exists to exercise structure, not
  to ship game data.
- **Size**: 21,705 bytes on disk, 72,503 bytes decompressed.
- **Layout**: mirrors the source exactly — 16-byte aligned entries inside the
  decompressed stream, 65,536-byte blocks, 16-byte aligned compressed blocks,
  a CRLF-terminated manifest at entry 0, MD5-of-lowercase-path entry hashes.

It spans **two blocks** deliberately. The two mistakes most likely to recur —
omitting 16-byte block alignment, and treating entry offsets as
stream-relative rather than as offsets into a virtual image of the file — are
both invisible in a single-block fixture and both fail loudly here.

### Regenerating

```
export PCBANKS="$HOME/.local/share/Steam/steamapps/common/No Man's Sky/GAMEDATA/PCBANKS"
go run testdata/gen.go -src "$PCBANKS/NMSARC.globals.pak" -out testdata/excerpt.pak
```

`gen.go` carries a `//go:build ignore` tag and is not part of the package
build.

## What the fixture does not cover

Two layout variants are exercised by hand-assembled archives in
`hgpak_test.go` rather than by this fixture, because `globals.pak` uses
neither. Each test names the real archive its structure was checked against:

| Variant | Test | Verified against |
|---|---|---|
| Stored (header `0x20` = 0, uncompressed, no block table) | `TestStoredArchiveLayout` | `NMSARC.audioBNK.pak` |
| Raw block (compressed length == 65536 means stored verbatim) | `TestRawBlockIsStoredNotCompressed` | `NMSARC.TexBiomesALPINE.pak` |

Both variants, and every other archive in the install, are covered end to end
by `TestFullArchivesFromRealInstall`, which is gated on `NMS_PCBANKS` and
skips when it is unset. Per ADR-0001 ingestion is developer-local and cannot
run in CI, so CI never sets it.

```
NMS_PCBANKS="$PCBANKS" go test ./internal/hgpak/
```
