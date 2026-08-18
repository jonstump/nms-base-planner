package hgpak_test

import (
	"bytes"
	"crypto/md5"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jonstump/nms-base-planner/internal/hgpak"
)

// Governing: SPEC-0003 REQ "Manifest and Path Resolution", REQ "Selective
// Extraction".
//
// The selectivity tests below assert on BlocksRead deltas rather than
// absolute counts, because Open reads the final block to settle StreamLen.
// A delta is also the honest measurement: the guarantee is about what a
// given call costs, not about the archive's lifetime total.

// storedArchive assembles a minimal stored-layout HGPAK. Structure checked
// against NMSARC.audioBNK.pak (storage flag 0, dataStart ==
// headerSize+entryCount*32, direct file offsets, plaintext CRLF manifest at
// entry 0).
//
// The stored layout is deliberate: these tests are about the manifest and
// the entry table agreeing, and stored archives let a test state exactly
// that disagreement without zstd framing in the way. manifest is passed
// separately from paths so a test can make the two contradict each other.
func storedArchive(paths []string, bodies [][]byte, manifest []byte, hashes [][16]byte) []byte {
	entries := append([][]byte{manifest}, bodies...)

	dataStart := 0x30 + 32*len(entries)
	blob := make([]byte, dataStart)
	copy(blob, []byte("HGPAK\x00\x00\x00"))
	binary.LittleEndian.PutUint64(blob[0x08:], hgpak.SupportedVersion)
	binary.LittleEndian.PutUint64(blob[0x10:], uint64(len(entries)))
	binary.LittleEndian.PutUint64(blob[0x18:], 0)
	binary.LittleEndian.PutUint64(blob[0x20:], hgpak.StorageStored)
	binary.LittleEndian.PutUint64(blob[0x28:], uint64(dataStart))

	for i, e := range entries {
		rec := blob[0x30+i*32:]
		if i > 0 {
			h := hashes[i-1]
			copy(rec[:16], h[:])
		}
		binary.LittleEndian.PutUint64(rec[16:], uint64(len(blob)))
		binary.LittleEndian.PutUint64(rec[24:], uint64(len(e)))
		blob = append(blob, e...)
	}
	return blob
}

// md5Paths returns the MD5-of-lowercase-path hash for each path, which is
// what a well-formed archive stores.
func md5Paths(paths []string) [][16]byte {
	out := make([][16]byte, len(paths))
	for i, p := range paths {
		out[i] = md5.Sum([]byte(strings.ToLower(p)))
	}
	return out
}

func crlf(paths []string) []byte {
	var b []byte
	for _, p := range paths {
		b = append(b, []byte(p+"\r\n")...)
	}
	return b
}

// SPEC-0003 REQ "Manifest and Path Resolution":
// WHEN an archive is opened with no external data available
// THEN every entry is listed by its full path.
func TestPathsNameEveryEntry(t *testing.T) {
	a := openFixture(t)

	paths, err := a.Paths()
	if err != nil {
		t.Fatalf("Paths: %v", err)
	}
	if got, want := len(paths), a.Len()-1; got != want {
		t.Fatalf("Paths returned %d paths, archive has %d entries (want %d)", got, a.Len(), want)
	}

	for i, p := range paths {
		idx := i + 1
		if p == "" {
			t.Errorf("entry %d has an empty path", idx)
			continue
		}
		// Every path resolves back to the entry it names.
		got, err := a.Lookup(p)
		if err != nil {
			t.Errorf("Lookup(%q): %v", p, err)
			continue
		}
		if got != idx {
			t.Errorf("Lookup(%q) = %d, want %d", p, got, idx)
		}
		// And Path is the inverse.
		back, err := a.Path(idx)
		if err != nil {
			t.Errorf("Path(%d): %v", idx, err)
		} else if back != p {
			t.Errorf("Path(%d) = %q, want %q", idx, back, p)
		}
		// Reading by path and by index agree.
		byPath, err := a.ReadPath(p)
		if err != nil {
			t.Errorf("ReadPath(%q): %v", p, err)
			continue
		}
		byIndex, err := a.ReadEntry(idx)
		if err != nil {
			t.Fatalf("ReadEntry(%d): %v", idx, err)
		}
		if !bytes.Equal(byPath, byIndex) {
			t.Errorf("ReadPath(%q) and ReadEntry(%d) disagree", p, idx)
		}
	}
}

// Manifest paths are lowercase by format, so a caller should not have to
// know that. A leading separator is tolerated as relative.
func TestLookupNormalizesTheQuery(t *testing.T) {
	a := openFixture(t)
	paths, err := a.Paths()
	if err != nil {
		t.Fatal(err)
	}
	want := 1
	p := paths[0]

	for _, q := range []string{p, strings.ToUpper(p), "/" + p} {
		got, err := a.Lookup(q)
		if err != nil {
			t.Errorf("Lookup(%q): %v", q, err)
			continue
		}
		if got != want {
			t.Errorf("Lookup(%q) = %d, want %d", q, got, want)
		}
	}
}

func TestUnknownPathIsEntryNotFound(t *testing.T) {
	a := openFixture(t)
	_, err := a.ReadPath("metadata/nothing/here.mbin")
	if !errors.Is(err, hgpak.ErrEntryNotFound) {
		t.Errorf("error is %v, want ErrEntryNotFound", err)
	}
}

// SPEC-0003 REQ "Manifest and Path Resolution":
// WHEN the manifest holds a number of paths other than entryCount-1
// THEN the read fails naming both counts.
func TestManifestCountMismatchNamesBothCounts(t *testing.T) {
	paths := []string{"a/one.mbin", "a/two.mbin"}
	bodies := [][]byte{[]byte("one"), []byte("two")}
	// Manifest lists a third path the entry table does not have.
	manifest := crlf(append(append([]string{}, paths...), "a/three.mbin"))

	blob := storedArchive(paths, bodies, manifest, md5Paths(paths))
	a, err := hgpak.Open(bytes.NewReader(blob), int64(len(blob)))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer a.Close()

	_, err = a.Paths()
	if err == nil {
		t.Fatal("Paths accepted a manifest disagreeing with the entry count")
	}
	if !errors.Is(err, hgpak.ErrMalformed) {
		t.Errorf("error is %v, want ErrMalformed", err)
	}
	msg := err.Error()
	// Both counts must appear: 3 paths against 2 expected.
	if !strings.Contains(msg, "3") || !strings.Contains(msg, "2") {
		t.Errorf("error %q does not name both counts", msg)
	}
}

// SPEC-0003 REQ "Manifest and Path Resolution":
// WHEN each entry's path is hashed with MD5
// THEN the digest equals the entry's stored hash, and any mismatch fails
// the read — rather than silently preferring one of the two.
func TestEntryHashMismatchIsRefused(t *testing.T) {
	paths := []string{"a/one.mbin", "a/two.mbin"}
	bodies := [][]byte{[]byte("one"), []byte("two")}
	hashes := md5Paths(paths)
	hashes[1][0] ^= 0xff // entry 2's hash no longer matches its path

	blob := storedArchive(paths, bodies, crlf(paths), hashes)
	a, err := hgpak.Open(bytes.NewReader(blob), int64(len(blob)))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer a.Close()

	_, err = a.Paths()
	if err == nil {
		t.Fatal("Paths accepted an entry whose hash is not the MD5 of its path")
	}
	if !errors.Is(err, hgpak.ErrMalformed) {
		t.Errorf("error is %v, want ErrMalformed", err)
	}
	if !strings.Contains(err.Error(), "entry hash") {
		t.Errorf("error %q does not name the structure at fault", err)
	}
}

// SPEC-0003 REQ "Selective Extraction":
// WHEN the paths of an archive are listed
// THEN only the blocks covering the manifest were decompressed.
func TestListingCostsOnlyManifestBlocks(t *testing.T) {
	a := openFixture(t)
	if a.BlockCount() < 2 {
		t.Fatalf("fixture spans %d block(s); this test needs at least 2", a.BlockCount())
	}

	before := a.BlocksRead()
	if _, err := a.Paths(); err != nil {
		t.Fatalf("Paths: %v", err)
	}
	spent := a.BlocksRead() - before

	// The manifest is entry 0 at stream position 0, so it costs exactly the
	// blocks it spans and nothing else.
	e, err := a.Entry(0)
	if err != nil {
		t.Fatal(err)
	}
	want := blocksSpanned(0, e.Size)
	if spent != want {
		t.Errorf("listing read %d blocks, want %d (the manifest spans %d bytes)", spent, want, e.Size)
	}
	if spent >= uint64(a.BlockCount()) {
		t.Errorf("listing read %d of %d blocks — it is not selective", spent, a.BlockCount())
	}

	// A second listing is served from cache and costs nothing.
	before = a.BlocksRead()
	if _, err := a.Paths(); err != nil {
		t.Fatal(err)
	}
	if spent := a.BlocksRead() - before; spent != 0 {
		t.Errorf("re-listing read %d blocks, want 0 (the manifest is resolved once)", spent)
	}
}

// SPEC-0003 REQ "Selective Extraction":
// WHEN a single entry is extracted THEN only the blocks spanning that entry
// were decompressed.
func TestSingleEntryReadCostsOnlyItsBlocks(t *testing.T) {
	a := openFixture(t)
	if a.BlockCount() < 2 {
		t.Fatalf("fixture spans %d block(s); this test needs at least 2", a.BlockCount())
	}
	// Resolve the manifest up front so its blocks are not attributed to the
	// entry read below.
	if _, err := a.Paths(); err != nil {
		t.Fatal(err)
	}

	// Prefer an entry that does not start in block 0 — reading one of those
	// is what proves the block-index arithmetic is doing real work.
	target, found := -1, false
	for i := 1; i < a.Len(); i++ {
		e, err := a.Entry(i)
		if err != nil {
			t.Fatal(err)
		}
		if a.StreamPos(e)/hgpak.BlockSize > 0 {
			target, found = i, true
			break
		}
	}
	if !found {
		t.Skip("no entry in the fixture starts past block 0")
	}

	e, err := a.Entry(target)
	if err != nil {
		t.Fatal(err)
	}
	before := a.BlocksRead()
	if _, err := a.ReadEntry(target); err != nil {
		t.Fatalf("ReadEntry(%d): %v", target, err)
	}
	spent := a.BlocksRead() - before

	want := blocksSpanned(a.StreamPos(e), e.Size)
	if spent != want {
		t.Errorf("reading entry %d (%d bytes at stream position %d) read %d blocks, want %d",
			target, e.Size, a.StreamPos(e), spent, want)
	}
}

// SPEC-0003 REQ "Selective Extraction": entry contents are read on demand,
// so opening an archive must not materialize its decompressed stream.
func TestOpenDoesNotMaterializeTheStream(t *testing.T) {
	a := openFixture(t)
	// readTables reads the final block to settle StreamLen exactly; nothing
	// else should have been touched.
	if got := a.BlocksRead(); got > 1 {
		t.Errorf("Open read %d of %d blocks, want at most 1 (the StreamLen probe)", got, a.BlockCount())
	}
	if a.StreamLen() == 0 {
		t.Error("StreamLen is 0 after Open")
	}
}

// blocksSpanned is the number of BlockSize blocks an extent covers. It is
// the arithmetic the reader itself relies on, restated here so a test
// failure points at the reader rather than at a shared helper.
func blocksSpanned(pos, size uint64) uint64 {
	if size == 0 {
		return 0
	}
	first := pos / hgpak.BlockSize
	last := (pos + size - 1) / hgpak.BlockSize
	return last - first + 1
}

// SPEC-0003 REQ "Manifest and Path Resolution" across a real install: every
// entry of every archive resolves by path, and every entry's hash is the
// MD5 of its lowercase path. Paths() verifies all of them, so a clean pass
// here is full verification rather than the spot-check the container test
// does.
func TestFullArchivePathResolutionFromRealInstall(t *testing.T) {
	dir := os.Getenv("NMS_PCBANKS")
	if dir == "" {
		t.Skip("NMS_PCBANKS is not set; skipping path resolution over a real install")
	}

	paks, err := filepath.Glob(filepath.Join(dir, "*.pak"))
	if err != nil {
		t.Fatal(err)
	}
	if len(paks) == 0 {
		t.Fatalf("NMS_PCBANKS=%s contains no .pak files", dir)
	}

	var totalPaths int
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

			// Opening a 47 MB archive must not decompress it.
			if opened := a.BlocksRead(); opened > 1 {
				t.Errorf("Open read %d of %d blocks", opened, a.BlockCount())
			}

			beforeList := a.BlocksRead()
			paths, err := a.Paths()
			if err != nil {
				t.Fatalf("Paths: %v", err)
			}
			if got, want := len(paths), a.Len()-1; got != want {
				t.Fatalf("Paths returned %d, want %d", got, want)
			}
			totalPaths += len(paths)

			// Listing a block-stream archive touches only the manifest's
			// blocks, never the whole archive.
			if !a.Stored() {
				e, err := a.Entry(0)
				if err != nil {
					t.Fatal(err)
				}
				if spent, want := a.BlocksRead()-beforeList, blocksSpanned(0, e.Size); spent != want {
					t.Errorf("listing read %d blocks, want %d", spent, want)
				}
			}

			// Every path resolves, and reading the last one costs only its
			// own blocks.
			last := len(paths)
			if got, err := a.Lookup(paths[last-1]); err != nil || got != last {
				t.Errorf("Lookup(%q) = %d, %v; want %d", paths[last-1], got, err, last)
			}
			e, err := a.Entry(last)
			if err != nil {
				t.Fatal(err)
			}
			if !a.Stored() {
				before := a.BlocksRead()
				if _, err := a.ReadEntry(last); err != nil {
					t.Fatalf("ReadEntry(%d): %v", last, err)
				}
				want := blocksSpanned(a.StreamPos(e), e.Size)
				if spent := a.BlocksRead() - before; spent != want {
					t.Errorf("reading the last entry read %d blocks, want %d", spent, want)
				}
			}
		})
	}
	t.Logf("resolved and hash-verified %s paths across %d archives",
		commas(totalPaths), len(paks))
}

func commas(n int) string {
	s := fmt.Sprintf("%d", n)
	if len(s) <= 3 {
		return s
	}
	var b strings.Builder
	lead := len(s) % 3
	if lead > 0 {
		b.WriteString(s[:lead])
	}
	for i := lead; i < len(s); i += 3 {
		if b.Len() > 0 {
			b.WriteByte(',')
		}
		b.WriteString(s[i : i+3])
	}
	return b.String()
}

// The manifest resolves at most once even under concurrent first use, and
// concurrent reads do not race. Worth asserting rather than assuming: the
// resolution is lazy, so the first Paths call mutates Archive state that
// every other reader is simultaneously reading, and CI runs -race.
func TestConcurrentUseIsSafe(t *testing.T) {
	a := openFixture(t)

	const goroutines = 16
	errs := make(chan error, goroutines)
	start := make(chan struct{})

	for i := range goroutines {
		go func(i int) {
			<-start // maximize the overlap on the lazy resolve
			paths, err := a.Paths()
			if err != nil {
				errs <- err
				return
			}
			if len(paths) != a.Len()-1 {
				errs <- fmt.Errorf("goroutine %d saw %d paths, want %d", i, len(paths), a.Len()-1)
				return
			}
			if _, err := a.ReadPath(paths[i%len(paths)]); err != nil {
				errs <- err
				return
			}
			errs <- nil
		}(i)
	}
	close(start)

	for range goroutines {
		if err := <-errs; err != nil {
			t.Error(err)
		}
	}
}
