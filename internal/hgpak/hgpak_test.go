package hgpak_test

import (
	"bytes"
	"crypto/md5"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/klauspost/compress/zstd"

	"github.com/jonstump/nms-base-planner/internal/hgpak"
)

// Governing: SPEC-0003 REQ "Real-Archive Verification", REQ "Container
// Identification", REQ "Structural Layout", REQ "Error Handling Standards".
//
// testdata/excerpt.pak is a real-archive excerpt, NOT a synthetic fixture:
// its 27 entries are verbatim bytes and verbatim paths taken from
// NMSARC.globals.pak of a real install (game files dated 2026-06-05), and it
// is assembled by testdata/gen.go to mirror that archive's layout exactly —
// 16-byte aligned entries inside the decompressed stream, 65536-byte blocks,
// 16-byte aligned compressed blocks, a CRLF-terminated manifest at entry 0,
// and MD5-of-lowercase-path entry hashes.
//
// It spans two blocks deliberately. The two mistakes most likely to recur —
// omitting 16-byte block alignment, and treating entry offsets as
// stream-relative rather than as offsets into a virtual image of the file —
// are both invisible in a single-block fixture and both fail loudly here.

const fixture = "testdata/excerpt.pak"

func openFixture(t *testing.T) *hgpak.Archive {
	t.Helper()
	f, err := os.Open(fixture)
	if err != nil {
		t.Fatalf("opening fixture: %v", err)
	}
	t.Cleanup(func() { f.Close() })
	st, err := f.Stat()
	if err != nil {
		t.Fatal(err)
	}
	a, err := hgpak.Open(f, st.Size())
	if err != nil {
		t.Fatalf("Open(%s): %v", fixture, err)
	}
	t.Cleanup(func() { a.Close() })
	return a
}

func fixtureBytes(t *testing.T) []byte {
	t.Helper()
	b, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatalf("reading fixture: %v", err)
	}
	return b
}

// manifestPaths splits a manifest blob into its CRLF-separated paths.
func manifestPaths(blob []byte) []string {
	trimmed := bytes.TrimSuffix(blob, []byte("\r\n"))
	if len(trimmed) == 0 {
		return nil
	}
	return strings.Split(string(trimmed), "\r\n")
}

// SPEC-0003 REQ "Real-Archive Verification":
// WHEN the test suite runs with no game install available
// THEN it opens the committed real-archive excerpt, lists its manifest, and
// extracts its entries.
func TestRealArchiveExcerpt(t *testing.T) {
	a := openFixture(t)

	if a.BlockCount() < 2 {
		t.Fatalf("fixture spans %d block(s); it must span at least 2 to be worth committing", a.BlockCount())
	}

	manifest, err := a.Manifest()
	if err != nil {
		t.Fatalf("Manifest: %v", err)
	}
	paths := manifestPaths(manifest)
	if got, want := len(paths), a.Len()-1; got != want {
		t.Fatalf("manifest lists %d paths, archive has %d entries (want %d paths)", got, a.Len(), want)
	}
	if !bytes.HasSuffix(manifest, []byte("\r\n")) {
		t.Error("manifest is not CRLF-terminated; real archives terminate every path including the last")
	}

	for i := 1; i < a.Len(); i++ {
		body, err := a.ReadEntry(i)
		if err != nil {
			t.Fatalf("ReadEntry(%d) [%s]: %v", i, paths[i-1], err)
		}
		e, err := a.Entry(i)
		if err != nil {
			t.Fatal(err)
		}
		if uint64(len(body)) != e.Size {
			t.Errorf("entry %d (%s): read %d bytes, table says %d", i, paths[i-1], len(body), e.Size)
		}
	}
}

// SPEC-0003 REQ "Manifest and Path Resolution" is story #10, but the hash
// convention is a property of the container this story parses, so the
// fixture asserts it here: an entry's hash is the MD5 of its lowercase path.
func TestEntryHashesAreMD5OfLowercasePath(t *testing.T) {
	a := openFixture(t)
	manifest, err := a.Manifest()
	if err != nil {
		t.Fatal(err)
	}
	paths := manifestPaths(manifest)
	for i := 1; i < a.Len(); i++ {
		e, err := a.Entry(i)
		if err != nil {
			t.Fatal(err)
		}
		want := md5.Sum([]byte(strings.ToLower(paths[i-1])))
		if e.Hash != want {
			t.Errorf("entry %d (%s): hash %x, want MD5 of lowercase path %x", i, paths[i-1], e.Hash, want)
		}
	}
}

// SPEC-0003 REQ "Structural Layout":
// WHEN an archive with more than one block is read
// THEN every block decompresses successfully, and the total decompressed
// length equals the block count times 65536 less any short final block.
func TestEveryBlockDecompressesAndTotalsCorrectly(t *testing.T) {
	a := openFixture(t)
	total := 0
	for i := 0; i < a.BlockCount(); i++ {
		blk, err := a.Block(i)
		if err != nil {
			t.Fatalf("Block(%d): %v", i, err)
		}
		if i < a.BlockCount()-1 && len(blk) != hgpak.BlockSize {
			t.Errorf("block %d decompressed to %d bytes, want exactly %d", i, len(blk), hgpak.BlockSize)
		}
		total += len(blk)
	}
	if uint64(total) != a.StreamLen() {
		t.Errorf("blocks total %d bytes, StreamLen reports %d", total, a.StreamLen())
	}
	// The identity the spec states, expressed directly.
	shortfall := a.BlockCount()*hgpak.BlockSize - total
	if shortfall < 0 || shortfall >= hgpak.BlockSize {
		t.Errorf("final block shortfall %d is outside [0, %d)", shortfall, hgpak.BlockSize)
	}
}

// SPEC-0003 REQ "Structural Layout":
// WHEN the first entry of an archive is read
// THEN it resolves to stream position zero, not to position dataStart.
//
// This is the virtual-offset regression. A reader that treats entry offsets
// as stream-relative reads dataStart bytes too far into the stream and
// returns plausible-looking garbage rather than failing outright, which is
// why it gets its own assertion instead of relying on a smoke test.
func TestEntryOffsetsAreVirtualNotStreamRelative(t *testing.T) {
	a := openFixture(t)
	first, err := a.Entry(0)
	if err != nil {
		t.Fatal(err)
	}
	if got := a.StreamPos(first); got != 0 {
		t.Errorf("entry 0 is at stream position %d, want 0", got)
	}
	if first.Offset != a.DataStart() {
		t.Errorf("entry 0 offset is %d, want dataStart %d", first.Offset, a.DataStart())
	}

	// Reading at the raw offset instead of the virtual one must not
	// accidentally agree — otherwise this test proves nothing.
	if a.DataStart() == 0 {
		t.Fatal("fixture has dataStart 0, which makes the virtual-offset distinction untestable")
	}

	manifest, err := a.ReadEntry(0)
	if err != nil {
		t.Fatal(err)
	}
	block0, err := a.Block(0)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(manifest, block0[:len(manifest)]) {
		t.Error("entry 0 does not start at the beginning of block 0; offsets are being resolved wrongly")
	}
}

// SPEC-0003 REQ "Structural Layout": blocks start on 16-byte boundaries.
// A reader that just accumulates compressed lengths lands mid-frame on the
// second block, so the assertion is that block 1 decompresses at all.
func TestBlockAlignmentIsHonoured(t *testing.T) {
	a := openFixture(t)
	if a.BlockCount() < 2 {
		t.Skip("fixture has one block; alignment is unobservable")
	}
	if _, err := a.Block(1); err != nil {
		t.Fatalf("block 1 failed to decompress, which is the signature of missing 16-byte alignment: %v", err)
	}
}

// SPEC-0003 REQ "Container Identification":
// WHEN a PSARC archive is opened
// THEN the read fails naming the magic found, and no entry table is parsed.
func TestPSARCIsRejectedNamingTheMagic(t *testing.T) {
	psarc := make([]byte, 256)
	copy(psarc, []byte("PSAR"))
	binary.BigEndian.PutUint32(psarc[4:], 0x00010004)

	_, err := hgpak.Open(bytes.NewReader(psarc), int64(len(psarc)))
	if err == nil {
		t.Fatal("Open accepted a PSARC archive")
	}
	if !errors.Is(err, hgpak.ErrNotHGPAK) {
		t.Errorf("error is %v, want ErrNotHGPAK", err)
	}
	if !strings.Contains(err.Error(), "PSAR") {
		t.Errorf("error %q does not name the magic found", err)
	}
}

// SPEC-0003 REQ "Container Identification":
// WHEN the version field holds a value this reader does not implement
// THEN the read fails naming the version, rather than parsing with version 2
// rules.
func TestUnsupportedVersionIsRefused(t *testing.T) {
	blob := fixtureBytes(t)
	binary.LittleEndian.PutUint64(blob[0x08:], 99)

	_, err := hgpak.Open(bytes.NewReader(blob), int64(len(blob)))
	if err == nil {
		t.Fatal("Open accepted an unknown version")
	}
	if !errors.Is(err, hgpak.ErrUnsupportedVersion) {
		t.Errorf("error is %v, want ErrUnsupportedVersion", err)
	}
	if !strings.Contains(err.Error(), "99") {
		t.Errorf("error %q does not name the version found", err)
	}
}

// SPEC-0003 REQ "Structural Layout":
// WHEN an entry's extent runs past the end of the decompressed stream
// THEN the read fails naming the entry, rather than returning a short buffer.
func TestEntryPastEndOfStreamIsRefused(t *testing.T) {
	blob := fixtureBytes(t)
	// Entry 1's size field lives at 0x30 + 32 + 24.
	binary.LittleEndian.PutUint64(blob[0x30+32+24:], 1<<40)

	a, err := hgpak.Open(bytes.NewReader(blob), int64(len(blob)))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer a.Close()

	body, err := a.ReadEntry(1)
	if err == nil {
		t.Fatalf("ReadEntry returned %d bytes for an entry running past the stream", len(body))
	}
	if !errors.Is(err, hgpak.ErrMalformed) {
		t.Errorf("error is %v, want ErrMalformed", err)
	}
	if !strings.Contains(err.Error(), "entry extent") {
		t.Errorf("error %q does not name the structural expectation violated", err)
	}
}

// SPEC-0003 REQ "Structural Layout": a block that decompresses to the wrong
// length is a malformed archive, not something to tolerate. Unlike PSARC,
// this format does not mix raw and compressed blocks, so a failed
// decompression is unambiguous.
func TestCorruptBlockIsRefused(t *testing.T) {
	blob := fixtureBytes(t)
	a, err := hgpak.Open(bytes.NewReader(blob), int64(len(blob)))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	dataStart := a.DataStart()
	a.Close()

	// Corrupt the first block's payload in place.
	for i := dataStart + 8; i < dataStart+24 && i < uint64(len(blob)); i++ {
		blob[i] ^= 0xff
	}

	a2, err := hgpak.Open(bytes.NewReader(blob), int64(len(blob)))
	if err != nil {
		// Failing at Open is also acceptable — readTables probes the final
		// block — provided the sentinel is right.
		if !errors.Is(err, hgpak.ErrMalformed) {
			t.Fatalf("error is %v, want ErrMalformed", err)
		}
		return
	}
	defer a2.Close()
	if _, err := a2.Block(0); err == nil {
		t.Fatal("Block(0) accepted a corrupted block")
	} else if !errors.Is(err, hgpak.ErrMalformed) {
		t.Errorf("error is %v, want ErrMalformed", err)
	}
}

// SPEC-0003 REQ "Error Handling Standards":
// WHEN a caller opens a PSARC file, versus an HGPAK whose blocks will not
// decompress THEN the two failures carry different sentinels.
func TestSentinelsAreDistinguishable(t *testing.T) {
	psarc := make([]byte, 256)
	copy(psarc, []byte("PSAR"))
	_, wrongFormat := hgpak.Open(bytes.NewReader(psarc), int64(len(psarc)))

	blob := fixtureBytes(t)
	binary.LittleEndian.PutUint64(blob[0x18:], 1<<40) // absurd block count
	_, corrupt := hgpak.Open(bytes.NewReader(blob), int64(len(blob)))

	if !errors.Is(wrongFormat, hgpak.ErrNotHGPAK) {
		t.Errorf("wrong-format error is %v, want ErrNotHGPAK", wrongFormat)
	}
	if !errors.Is(corrupt, hgpak.ErrMalformed) {
		t.Errorf("corrupt-structure error is %v, want ErrMalformed", corrupt)
	}
	if errors.Is(corrupt, hgpak.ErrNotHGPAK) {
		t.Error("a corrupt HGPAK is being reported as the wrong format")
	}
	if errors.Is(wrongFormat, hgpak.ErrMalformed) {
		t.Error("a PSARC file is being reported as a corrupt HGPAK")
	}
}

// SPEC-0003 REQ "Error Handling Standards": the five sentinels exist and are
// mutually distinct, including ErrUnsafePath, which the extraction layer
// (story #11) returns.
func TestAllSentinelsExistAndAreDistinct(t *testing.T) {
	all := []error{
		hgpak.ErrNotHGPAK,
		hgpak.ErrUnsupportedVersion,
		hgpak.ErrMalformed,
		hgpak.ErrEntryNotFound,
		hgpak.ErrUnsafePath,
	}
	for i, a := range all {
		for j, b := range all {
			if i != j && errors.Is(a, b) {
				t.Errorf("sentinel %d and %d are not distinct: %v / %v", i, j, a, b)
			}
		}
	}
}

// SPEC-0003 REQ "Error Handling Standards": structural errors expose their
// fields for key-value logging rather than requiring a caller to scrape a
// formatted message.
func TestStructureErrorCarriesLoggableFields(t *testing.T) {
	blob := fixtureBytes(t)
	binary.LittleEndian.PutUint64(blob[0x30+32+24:], 1<<40)
	a, err := hgpak.Open(bytes.NewReader(blob), int64(len(blob)))
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()

	_, err = a.ReadEntry(1)
	var se *hgpak.StructureError
	if !errors.As(err, &se) {
		t.Fatalf("error %v is not a *StructureError", err)
	}
	attrs := se.LogAttrs()
	if len(attrs)%2 != 0 {
		t.Errorf("LogAttrs returned %d values; key-value pairs must be even", len(attrs))
	}
	if se.Op == "" {
		t.Error("StructureError.Op is empty")
	}
}

func TestEntryOutOfRange(t *testing.T) {
	a := openFixture(t)
	if _, err := a.Entry(a.Len()); !errors.Is(err, hgpak.ErrEntryNotFound) {
		t.Errorf("error is %v, want ErrEntryNotFound", err)
	}
	if _, err := a.Entry(-1); !errors.Is(err, hgpak.ErrEntryNotFound) {
		t.Errorf("error is %v, want ErrEntryNotFound", err)
	}
}

func TestTooShortToBeAnArchive(t *testing.T) {
	if _, err := hgpak.Open(bytes.NewReader([]byte("HGPAK")), 5); !errors.Is(err, hgpak.ErrNotHGPAK) {
		t.Errorf("error is %v, want ErrNotHGPAK", err)
	}
}

// SPEC-0003 REQ "Real-Archive Verification":
// WHEN the environment variable naming a PCBANKS directory is set
// THEN the suite opens every archive in it and verifies each one's manifest
// and entry count
// AND WHEN it is unset, those tests report as skipped rather than passing.
//
// CI never sets NMS_PCBANKS: per ADR-0001 ingestion is developer-local and
// cannot run in CI, so this must skip cleanly there.
func TestFullArchivesFromRealInstall(t *testing.T) {
	dir := os.Getenv("NMS_PCBANKS")
	if dir == "" {
		t.Skip("NMS_PCBANKS is not set; skipping the full-archive pass over a real install")
	}

	paks, err := filepath.Glob(filepath.Join(dir, "*.pak"))
	if err != nil {
		t.Fatal(err)
	}
	if len(paks) == 0 {
		t.Fatalf("NMS_PCBANKS=%s contains no .pak files", dir)
	}

	for _, p := range paks {
		t.Run(filepath.Base(p), func(t *testing.T) {
			f, err := os.Open(p)
			if err != nil {
				t.Fatal(err)
			}
			defer f.Close()
			st, err := f.Stat()
			if err != nil {
				t.Fatal(err)
			}
			a, err := hgpak.Open(f, st.Size())
			if err != nil {
				t.Fatalf("Open: %v", err)
			}
			defer a.Close()

			if a.Version() != hgpak.SupportedVersion {
				t.Errorf("version %d, want %d", a.Version(), hgpak.SupportedVersion)
			}
			switch a.Storage() {
			case hgpak.StorageBlocks, hgpak.StorageStored:
			default:
				t.Errorf("storage flag is %d, want %d or %d", a.Storage(), hgpak.StorageBlocks, hgpak.StorageStored)
			}

			manifest, err := a.Manifest()
			if err != nil {
				t.Fatalf("Manifest: %v", err)
			}
			paths := manifestPaths(manifest)
			if got, want := len(paths), a.Len()-1; got != want {
				t.Errorf("manifest lists %d paths, want %d (entry count %d)", got, want, a.Len())
			}

			// Spot-check the hash convention rather than hashing all 47,000
			// paths in every archive.
			for i := 1; i < a.Len() && i <= 25; i++ {
				e, err := a.Entry(i)
				if err != nil {
					t.Fatal(err)
				}
				if want := md5.Sum([]byte(strings.ToLower(paths[i-1]))); e.Hash != want {
					t.Errorf("entry %d (%s): hash %x, want %x", i, paths[i-1], e.Hash, want)
				}
			}
		})
	}
}

// SPEC-0003 REQ "Structural Layout" (extended): the header field at 0x20
// selects the storage layout. The block-stream layout (1) is what the spec
// documents; the stored layout (0) is what NMSARC.audio.pak and
// NMSARC.audioBNK.pak actually use, discovered by running
// TestFullArchivesFromRealInstall across a real install. Structure verified
// against NMSARC.audioBNK.pak: dataStart == headerSize+entryCount*32, entry
// offsets are direct file offsets, and entry 0 is a plaintext CRLF manifest.
func TestStoredArchiveLayout(t *testing.T) {
	paths := []string{"audio/windows/one.bnk", "audio/windows/two.bnk"}
	bodies := [][]byte{[]byte("first body bytes"), []byte("second body, a little longer")}

	var manifest []byte
	for _, p := range paths {
		manifest = append(manifest, []byte(p+"\r\n")...)
	}
	entries := append([][]byte{manifest}, bodies...)

	dataStart := 0x30 + 32*len(entries)
	blob := make([]byte, dataStart)
	copy(blob, []byte("HGPAK\x00\x00\x00"))
	binary.LittleEndian.PutUint64(blob[0x08:], hgpak.SupportedVersion)
	binary.LittleEndian.PutUint64(blob[0x10:], uint64(len(entries)))
	binary.LittleEndian.PutUint64(blob[0x18:], 7) // blockCount is vestigial here
	binary.LittleEndian.PutUint64(blob[0x20:], hgpak.StorageStored)
	binary.LittleEndian.PutUint64(blob[0x28:], uint64(dataStart))

	for i, e := range entries {
		rec := blob[0x30+i*32:]
		if i > 0 {
			sum := md5.Sum([]byte(strings.ToLower(paths[i-1])))
			copy(rec[:16], sum[:])
		}
		binary.LittleEndian.PutUint64(rec[16:], uint64(len(blob)))
		binary.LittleEndian.PutUint64(rec[24:], uint64(len(e)))
		blob = append(blob, e...)
	}

	a, err := hgpak.Open(bytes.NewReader(blob), int64(len(blob)))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer a.Close()

	if !a.Stored() {
		t.Fatalf("Stored() is false for a storage flag of %d", a.Storage())
	}
	if int(a.DataStart()) != dataStart {
		t.Errorf("dataStart %d, want headerSize+entryCount*32 = %d", a.DataStart(), dataStart)
	}
	got, err := a.Manifest()
	if err != nil {
		t.Fatalf("Manifest: %v", err)
	}
	if !bytes.Equal(got, manifest) {
		t.Errorf("manifest = %q, want %q", got, manifest)
	}
	for i, want := range bodies {
		body, err := a.ReadEntry(i + 1)
		if err != nil {
			t.Fatalf("ReadEntry(%d): %v", i+1, err)
		}
		if !bytes.Equal(body, want) {
			t.Errorf("entry %d = %q, want %q", i+1, body, want)
		}
	}
	// A stored archive has no block layer at all.
	if _, err := a.Block(0); err == nil {
		t.Error("Block(0) succeeded on a stored archive")
	}
}

// An unrecognized storage flag must be refused rather than guessed at.
func TestUnknownStorageFlagIsRefused(t *testing.T) {
	blob := fixtureBytes(t)
	binary.LittleEndian.PutUint64(blob[0x20:], 42)
	_, err := hgpak.Open(bytes.NewReader(blob), int64(len(blob)))
	if !errors.Is(err, hgpak.ErrMalformed) {
		t.Errorf("error is %v, want ErrMalformed", err)
	}
	if !strings.Contains(err.Error(), "storage flag") {
		t.Errorf("error %q does not name the storage flag", err)
	}
}

// SPEC-0003 REQ "Structural Layout" (extended): a block whose compressed
// length is exactly BlockSize is stored raw rather than zstd-compressed.
// Eight archives in a real install use this — NMSARC.UI.pak and the
// NMSARC.TexBiomes* family — and their block 0 is plaintext manifest text
// where a zstd frame would otherwise be. Structure verified against
// NMSARC.TexBiomesALPINE.pak (dataStart 14208, block 0 length 65536,
// beginning "text").
//
// The rule is a length comparison, not a magic sniff, so it does not
// reintroduce the PSARC-style inflate-and-fall-back the design doc rejects:
// a block that is not exactly BlockSize long and then fails to decompress is
// still a hard structural error.
func TestRawBlockIsStoredNotCompressed(t *testing.T) {
	enc, err := zstd.NewWriter(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer enc.Close()

	// Block 0 is stored raw (length exactly BlockSize); block 1 is zstd.
	rawBlock := bytes.Repeat([]byte("incompressible-ish "), hgpak.BlockSize/19+1)[:hgpak.BlockSize]
	tailPlain := []byte("tail block contents")
	tailComp := enc.EncodeAll(tailPlain, nil)

	entries := [][]byte{[]byte("only/one/path.mbin\r\n")}
	blockLens := []uint64{hgpak.BlockSize, uint64(len(tailComp))}

	dataStart := 0x30 + 32*len(entries) + 8*len(blockLens)
	if r := dataStart % 16; r != 0 {
		dataStart += 16 - r
	}
	blob := make([]byte, dataStart)
	copy(blob, []byte("HGPAK\x00\x00\x00"))
	binary.LittleEndian.PutUint64(blob[0x08:], hgpak.SupportedVersion)
	binary.LittleEndian.PutUint64(blob[0x10:], uint64(len(entries)))
	binary.LittleEndian.PutUint64(blob[0x18:], uint64(len(blockLens)))
	binary.LittleEndian.PutUint64(blob[0x20:], hgpak.StorageBlocks)
	binary.LittleEndian.PutUint64(blob[0x28:], uint64(dataStart))
	binary.LittleEndian.PutUint64(blob[0x30+16:], uint64(dataStart)) // entry 0 offset
	binary.LittleEndian.PutUint64(blob[0x30+24:], uint64(len(entries[0])))
	for i, n := range blockLens {
		binary.LittleEndian.PutUint64(blob[0x30+32*len(entries)+i*8:], n)
	}

	// Copy the raw block over the front of the stream so entry 0 reads out
	// of it, then append both blocks 16-byte aligned.
	stream := append([]byte{}, rawBlock...)
	copy(stream, entries[0])
	blob = append(blob, stream...)
	if r := len(blob) % 16; r != 0 {
		blob = append(blob, make([]byte, 16-r)...)
	}
	blob = append(blob, tailComp...)

	a, err := hgpak.Open(bytes.NewReader(blob), int64(len(blob)))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer a.Close()

	b0, err := a.Block(0)
	if err != nil {
		t.Fatalf("Block(0) on a raw-stored block: %v", err)
	}
	if len(b0) != hgpak.BlockSize {
		t.Errorf("raw block decompressed to %d bytes, want %d", len(b0), hgpak.BlockSize)
	}
	if !bytes.HasPrefix(b0, entries[0]) {
		t.Error("raw block was not returned verbatim")
	}
	b1, err := a.Block(1)
	if err != nil {
		t.Fatalf("Block(1) on a zstd block: %v", err)
	}
	if !bytes.Equal(b1, tailPlain) {
		t.Errorf("zstd block = %q, want %q", b1, tailPlain)
	}

	manifest, err := a.Manifest()
	if err != nil {
		t.Fatalf("Manifest: %v", err)
	}
	if !bytes.Equal(manifest, entries[0]) {
		t.Errorf("manifest = %q, want %q", manifest, entries[0])
	}
}

// SPEC-0003 REQ "Structural Layout" ("A truncated archive is refused") and
// REQ "Error Handling Standards" (every error is *returned to the caller*).
//
// Entry sizes come straight off the entry table and are otherwise unbounded,
// so the extent check must not be written as pos+e.Size: that sum wraps for
// a size near 2^64 and lands back inside the stream, after which the
// make([]byte, 0, e.Size) below it panics. A panic is not a returned error
// and takes the whole sentinel vocabulary with it, so this asserts the
// sentinel rather than merely asserting that the call did not crash.
func TestOversizedEntryIsRefusedNotPanicked(t *testing.T) {
	blob := fixtureBytes(t)
	a, err := hgpak.Open(bytes.NewReader(blob), int64(len(blob)))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	e, err := a.Entry(1)
	if err != nil {
		t.Fatalf("Entry(1): %v", err)
	}
	pos := a.StreamPos(e)
	a.Close()
	if pos == 0 {
		t.Fatal("entry 1 is at stream position 0; the wrap this guards needs a nonzero position")
	}

	// Choose Size so that pos+Size wraps to 16 — comfortably "inside" the
	// stream by the naive check, and absurd by any honest one.
	binary.LittleEndian.PutUint64(blob[0x30+32+24:], ^uint64(0)-pos+1+16)

	a2, err := hgpak.Open(bytes.NewReader(blob), int64(len(blob)))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer a2.Close()

	body, err := a2.ReadEntry(1)
	if err == nil {
		t.Fatalf("ReadEntry returned %d bytes for an entry whose size wraps the stream bound", len(body))
	}
	if !errors.Is(err, hgpak.ErrMalformed) {
		t.Errorf("error is %v, want ErrMalformed", err)
	}
	if !strings.Contains(err.Error(), "entry extent") {
		t.Errorf("error %q does not name the structural expectation violated", err)
	}
}

// SPEC-0003 REQ "Error Handling Standards": a self-contradicting block table
// is malformed structure and must carry ErrMalformed, whichever block holds
// the bad length.
//
// A length >= 2^63 is negative as an int64, so a bound written as
// "pos+int64(n) > a.size" passes it through. On the final block that reaches
// make([]byte, n) and panics inside Open; on any earlier block it drives pos
// negative and surfaces as a raw ReadAt error, which is worse than useless
// to a caller — it blames the disk for a corrupt file. Both positions are
// covered because they failed differently before the fix.
func TestHugeBlockLengthIsRefusedWithSentinel(t *testing.T) {
	base := fixtureBytes(t)
	entryCount := binary.LittleEndian.Uint64(base[0x10:])
	blockCount := binary.LittleEndian.Uint64(base[0x18:])
	blockTable := 0x30 + int(entryCount)*entrySizeForTest
	if blockCount < 2 {
		t.Fatalf("fixture has %d blocks; this test needs the two-block layout", blockCount)
	}

	for _, tc := range []struct {
		name  string
		index int
	}{
		{"first block", 0},
		{"final block", int(blockCount) - 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			blob := bytes.Clone(base)
			binary.LittleEndian.PutUint64(blob[blockTable+tc.index*8:], 1<<63)

			a, err := hgpak.Open(bytes.NewReader(blob), int64(len(blob)))
			if err == nil {
				a.Close()
				t.Fatal("Open accepted a 2^63-byte block length")
			}
			if !errors.Is(err, hgpak.ErrMalformed) {
				t.Errorf("error is %v, want ErrMalformed", err)
			}
			if !strings.Contains(err.Error(), "block extent") {
				t.Errorf("error %q does not name the structural expectation violated", err)
			}
		})
	}
}

// entrySizeForTest mirrors the package's unexported entrySize. The tests are
// in package hgpak_test on purpose — they exercise the exported surface a
// caller sees — so the record stride is restated here rather than exported
// from the package just for tests.
const entrySizeForTest = 32

// SPEC-0003 REQ "Container Identification": a mismatch MUST fail "with an
// error naming the magic found".
//
// The requirement's own scenario uses a PSARC file, whose header starts with
// four printable bytes — so the obvious implementation, reporting the leading
// printable run, satisfies the scenario while naming nothing for any file
// that starts with a binary byte. A gzip archive was refused with
// `magic is ""`, which tells the reader neither what they opened nor that
// anything was read at all.
func TestNonPrintableMagicIsStillNamed(t *testing.T) {
	for _, tc := range []struct {
		name  string
		magic []byte
		want  string // a substring the message must carry
	}{
		{"gzip", []byte{0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0}, "1f8b0800"},
		{"all binary", []byte{0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07}, "0001020304050607"},
		{"zstd frame", []byte{0x28, 0xb5, 0x2f, 0xfd, 0, 0, 0, 0}, "28b52ffd"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			buf := make([]byte, 0x30)
			copy(buf, tc.magic)

			_, err := hgpak.Open(bytes.NewReader(buf), int64(len(buf)))
			if err == nil {
				t.Fatal("Open accepted a non-HGPAK file")
			}
			if !errors.Is(err, hgpak.ErrNotHGPAK) {
				t.Errorf("error is %v, want ErrNotHGPAK", err)
			}
			msg := err.Error()
			if strings.Contains(msg, `magic is ""`) || strings.Contains(msg, "magic is ,") {
				t.Errorf("error names no magic at all: %q", msg)
			}
			if !strings.Contains(msg, tc.want) {
				t.Errorf("error %q does not carry the magic bytes %s", msg, tc.want)
			}
		})
	}
}

// The eight-byte magic is reported in full even when part of it is
// printable: "PSAR" is the recognisable half of a PSARC header, not all of
// it, and a reader diagnosing a wrong-format file wants the rest.
func TestPrintableMagicIsReportedWithItsFullBytes(t *testing.T) {
	psarc := make([]byte, 0x30)
	copy(psarc, []byte("PSAR"))
	binary.BigEndian.PutUint32(psarc[4:], 0x00010004)

	_, err := hgpak.Open(bytes.NewReader(psarc), int64(len(psarc)))
	if err == nil {
		t.Fatal("Open accepted a PSARC archive")
	}
	msg := err.Error()
	if !strings.Contains(msg, "PSAR") {
		t.Errorf("error %q lost the recognisable prefix", msg)
	}
	if !strings.Contains(msg, "5053415200010004") {
		t.Errorf("error %q does not carry all eight magic bytes", msg)
	}
}
