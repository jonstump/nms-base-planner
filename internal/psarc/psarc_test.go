package psarc

import (
	"bytes"
	"compress/zlib"
	"crypto/md5"
	"encoding/binary"
	"errors"
	"math/rand"
	"strings"
	"testing"
)

// buildArchive assembles a format-correct PSARC from ordered name/content
// pairs, so the reader can be exercised without a real .pak. It mirrors the
// writer side of the format: entry 0 is the manifest, every entry is split
// into blockSize chunks, and each chunk is stored compressed when that is
// smaller and raw otherwise.
func buildArchive(t *testing.T, blockSize uint32, names []string, contents [][]byte) []byte {
	t.Helper()

	payloads := append([][]byte{[]byte(strings.Join(names, "\n"))}, contents...)

	type staged struct {
		uncompressed int64
		firstBlock   uint32
		data         []byte
	}
	var stagedEntries []staged
	var blockLens []uint32

	for _, p := range payloads {
		s := staged{uncompressed: int64(len(p)), firstBlock: uint32(len(blockLens))}
		for off := 0; off < len(p); off += int(blockSize) {
			end := off + int(blockSize)
			if end > len(p) {
				end = len(p)
			}
			chunk := p[off:end]

			var zbuf bytes.Buffer
			zw := zlib.NewWriter(&zbuf)
			zw.Write(chunk)
			zw.Close()

			if zbuf.Len() < len(chunk) {
				s.data = append(s.data, zbuf.Bytes()...)
				blockLens = append(blockLens, uint32(zbuf.Len()))
				continue
			}
			// Raw. A full-size block records 0; a short trailing block
			// records its own length.
			s.data = append(s.data, chunk...)
			if len(chunk) == int(blockSize) {
				blockLens = append(blockLens, 0)
			} else {
				blockLens = append(blockLens, uint32(len(chunk)))
			}
		}
		if len(p) == 0 {
			blockLens = append(blockLens, 0)
		}
		stagedEntries = append(stagedEntries, s)
	}

	const entrySize = 30
	width := blockWidth(blockSize)
	tocLength := headerSize + len(stagedEntries)*entrySize + len(blockLens)*width

	var toc bytes.Buffer
	offset := int64(tocLength)
	for i, s := range stagedEntries {
		sum := md5.Sum([]byte(nameOf(i, names)))
		toc.Write(sum[:])
		binary.Write(&toc, binary.BigEndian, s.firstBlock)
		toc.Write(put40(uint64(s.uncompressed)))
		toc.Write(put40(uint64(offset)))
		offset += int64(len(s.data))
	}
	for _, bl := range blockLens {
		b := make([]byte, 4)
		binary.BigEndian.PutUint32(b, bl)
		toc.Write(b[4-width:])
	}

	var out bytes.Buffer
	out.WriteString(magic)
	binary.Write(&out, binary.BigEndian, uint16(1))
	binary.Write(&out, binary.BigEndian, uint16(4))
	out.WriteString(compZlib)
	binary.Write(&out, binary.BigEndian, uint32(tocLength))
	binary.Write(&out, binary.BigEndian, uint32(entrySize))
	binary.Write(&out, binary.BigEndian, uint32(len(stagedEntries)))
	binary.Write(&out, binary.BigEndian, blockSize)
	binary.Write(&out, binary.BigEndian, uint32(0))
	out.Write(toc.Bytes())
	for _, s := range stagedEntries {
		out.Write(s.data)
	}
	return out.Bytes()
}

func nameOf(i int, names []string) string {
	if i == 0 {
		return ""
	}
	return names[i-1]
}

func put40(v uint64) []byte {
	return []byte{byte(v >> 32), byte(v >> 24), byte(v >> 16), byte(v >> 8), byte(v)}
}

func open(t *testing.T, b []byte) *Archive {
	t.Helper()
	a, err := Open(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return a
}

// Compressible, uncompressible, multi-block, and empty payloads in one
// archive — the four block shapes the reader has to tell apart.
func TestRoundTrip(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	incompressible := make([]byte, 5000)
	rng.Read(incompressible)

	multiBlock := make([]byte, 300000) // several 64 KiB blocks
	for i := range multiBlock {
		multiBlock[i] = byte(i % 251)
	}

	names := []string{
		"METADATA/REALITY/TABLES/NMS_REALITY_GCPRODUCTTABLE.MBIN",
		"random.bin",
		"big.bin",
		"empty.bin",
	}
	contents := [][]byte{
		bytes.Repeat([]byte("compressible "), 400),
		incompressible,
		multiBlock,
		{},
	}

	a := open(t, buildArchive(t, 65536, names, contents))

	if got := a.Names(); len(got) != len(names) {
		t.Fatalf("Names() = %v, want %d entries", got, len(names))
	}
	for i, name := range names {
		if a.Names()[i] != name {
			t.Errorf("Names()[%d] = %q, want %q", i, a.Names()[i], name)
		}
		got, err := a.ReadFile(name)
		if err != nil {
			t.Fatalf("ReadFile(%q): %v", name, err)
		}
		if !bytes.Equal(got, contents[i]) {
			t.Errorf("%s: %d bytes read, want %d (equal=%v)", name, len(got), len(contents[i]), bytes.Equal(got, contents[i]))
		}
	}
}

func TestLeadingSlashIsTolerated(t *testing.T) {
	a := open(t, buildArchive(t, 65536, []string{"/A/B.MBIN"}, [][]byte{[]byte("x")}))
	if got := a.Names()[0]; got != "A/B.MBIN" {
		t.Errorf("name = %q, want the leading slash trimmed", got)
	}
	if _, err := a.ReadFile("A/B.MBIN"); err != nil {
		t.Errorf("ReadFile without slash: %v", err)
	}
	if _, err := a.ReadFile("/A/B.MBIN"); err != nil {
		t.Errorf("ReadFile with slash: %v", err)
	}
}

func TestSmallBlockSizeUsesNarrowTable(t *testing.T) {
	// Exercises multi-block reads and a 1-byte block table together.
	payload := bytes.Repeat([]byte("xyz"), 500)
	a := open(t, buildArchive(t, 256, []string{"f.bin"}, [][]byte{payload}))
	got, err := a.ReadFile("f.bin")
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Errorf("round trip mismatch: %d bytes, want %d", len(got), len(payload))
	}
}

func TestEntriesReportSizes(t *testing.T) {
	a := open(t, buildArchive(t, 65536, []string{"a", "b"}, [][]byte{[]byte("1234"), []byte("567")}))
	es := a.Entries()
	if len(es) != 2 {
		t.Fatalf("Entries() = %d, want 2 (manifest excluded)", len(es))
	}
	if es[0].UncompressedSize != 4 || es[1].UncompressedSize != 3 {
		t.Errorf("sizes = %d, %d; want 4, 3", es[0].UncompressedSize, es[1].UncompressedSize)
	}
}

func TestSentinels(t *testing.T) {
	good := buildArchive(t, 65536, []string{"a"}, [][]byte{[]byte("hello")})

	corruptHeader := func(mutate func([]byte)) []byte {
		b := append([]byte(nil), good...)
		mutate(b)
		return b
	}

	for _, tc := range []struct {
		name string
		in   []byte
		want error
	}{
		{"bad magic", corruptHeader(func(b []byte) { copy(b[0:4], "XXXX") }), ErrNotPSARC},
		{"unsupported compression", corruptHeader(func(b []byte) { copy(b[8:12], "lzma") }), ErrUnsupported},
		{"encrypted toc", corruptHeader(func(b []byte) { binary.BigEndian.PutUint32(b[28:32], 1) }), ErrUnsupported},
		{"zero entries", corruptHeader(func(b []byte) { binary.BigEndian.PutUint32(b[20:24], 0) }), ErrCorrupt},
		{"zero block size", corruptHeader(func(b []byte) { binary.BigEndian.PutUint32(b[24:28], 0) }), ErrCorrupt},
		{"toc longer than archive", corruptHeader(func(b []byte) { binary.BigEndian.PutUint32(b[12:16], 1<<30) }), ErrCorrupt},
		{"entry count overruns toc", corruptHeader(func(b []byte) { binary.BigEndian.PutUint32(b[20:24], 9999) }), ErrCorrupt},
		{"truncated", good[:16], ErrCorrupt},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Open(bytes.NewReader(tc.in), int64(len(tc.in)))
			if !errors.Is(err, tc.want) {
				t.Errorf("err = %v, want %v", err, tc.want)
			}
		})
	}

	a := open(t, good)
	if _, err := a.ReadFile("nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing file err = %v, want ErrNotFound", err)
	}
}

func TestHeaderIsParsed(t *testing.T) {
	a := open(t, buildArchive(t, 65536, []string{"a"}, [][]byte{[]byte("x")}))
	if a.VersionMajor != 1 || a.VersionMinor != 4 {
		t.Errorf("version = %d.%d, want 1.4", a.VersionMajor, a.VersionMinor)
	}
	if a.Compression != "zlib" {
		t.Errorf("compression = %q, want zlib", a.Compression)
	}
	if a.BlockSize != 65536 {
		t.Errorf("block size = %d, want 65536", a.BlockSize)
	}
}

func TestBlockWidth(t *testing.T) {
	for _, tc := range []struct {
		blockSize uint32
		want      int
	}{
		{0x100, 1}, {0x101, 2}, {0x10000, 2}, {0x10001, 3},
		{0x1000000, 3}, {0x1000001, 4},
	} {
		if got := blockWidth(tc.blockSize); got != tc.want {
			t.Errorf("blockWidth(%#x) = %d, want %d", tc.blockSize, got, tc.want)
		}
	}
}

func TestRead40(t *testing.T) {
	// 40 bits exist so archives can exceed 4 GiB; the top byte must survive.
	for _, tc := range []struct {
		in   []byte
		want uint64
	}{
		{[]byte{0, 0, 0, 0, 0}, 0},
		{[]byte{0, 0, 0, 0, 1}, 1},
		{[]byte{0, 0, 1, 0, 0}, 1 << 16},
		{[]byte{1, 0, 0, 0, 0}, 1 << 32},
		{[]byte{0xFF, 0xFF, 0xFF, 0xFF, 0xFF}, 1<<40 - 1},
	} {
		if got := read40(tc.in); got != tc.want {
			t.Errorf("read40(%v) = %d, want %d", tc.in, got, tc.want)
		}
	}
}

// A raw block can open with bytes that look like a zlib header by chance.
// Inflation must fail and the block fall back to raw rather than erroring.
func TestChanceZlibHeaderInRawBlockIsNotMisread(t *testing.T) {
	payload := make([]byte, 64)
	payload[0], payload[1] = 0x78, 0x9C // a real zlib header pair
	for i := 2; i < len(payload); i++ {
		payload[i] = byte(i * 7)
	}
	if _, ok := tryInflate(payload); ok {
		t.Fatal("tryInflate accepted non-zlib data; the adler32 check should reject it")
	}

	a := open(t, buildArchive(t, 256, []string{"f.bin"}, [][]byte{payload}))
	got, err := a.ReadFile("f.bin")
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Error("payload with a chance zlib header did not round trip")
	}
}
