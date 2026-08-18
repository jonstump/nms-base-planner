// Package psarc reads PlayStation Archive (PSARC) files.
//
// No Man's Sky ships its assets as .pak files under GAMEDATA/PCBANKS, which
// are PSARC archives despite the extension. MBINCompiler operates on already
// unpacked .MBIN files, so unpacking is our step.
//
// Governing: ADR-0001 (two-tier NMS data ingestion) — stage 1 of the
// ingestion pipeline, "locate + extract PAKs".
//
// The format, all integers big-endian:
//
//	header      32 bytes: magic, version, compression, toc length, entry
//	            size, entry count, block size, flags
//	toc         entryCount * entrySize bytes; each entry is a 16-byte md5 of
//	            the path, a uint32 index into the block table, and two 40-bit
//	            values (uncompressed size, archive offset)
//	blocks      fills the remainder of the toc; each value is the compressed
//	            length of one block, 0 meaning a full uncompressed block
//	data        the blocks themselves
//
// Entry 0 is the manifest: a newline-separated list of paths for entries
// 1..n-1, compressed like any other entry. Paths therefore cost one
// decompression to learn.
package psarc

import (
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"strings"
)

// Sentinel errors for the failure modes callers need to distinguish.
//
// Governing: ADR-0001; error-handling standards mirror SPEC-0001 REQ "Error
// Handling Standards" so the ingestion CLI and the domain behave alike.
var (
	// ErrNotPSARC reports a file whose magic is not "PSAR".
	ErrNotPSARC = errors.New("not a PSARC archive")

	// ErrUnsupported reports a well-formed archive this reader cannot handle
	// — an unknown compression scheme or an encrypted table of contents.
	ErrUnsupported = errors.New("unsupported PSARC variant")

	// ErrCorrupt reports internally inconsistent data: truncated reads,
	// out-of-range offsets, or a block stream that does not produce the
	// declared uncompressed size.
	ErrCorrupt = errors.New("corrupt PSARC archive")

	// ErrNotFound reports a path absent from the archive manifest.
	ErrNotFound = errors.New("file not found in archive")
)

const (
	magic            = "PSAR"
	headerSize       = 32
	compZlib         = "zlib"
	flagTOCEncrypted = 1 << 0
)

// Entry is one file in the archive.
type Entry struct {
	// Name is the archive-relative path. Empty for entry 0, the manifest.
	Name string

	// UncompressedSize is the size Read returns on success.
	UncompressedSize int64

	blockIndex  uint32
	startOffset int64
}

// Archive is an opened PSARC. It holds no decompressed data; entries are
// inflated on demand, because a PCBANKS .pak is far larger than we want
// resident.
type Archive struct {
	r io.ReaderAt

	VersionMajor uint16
	VersionMinor uint16
	Compression  string
	BlockSize    uint32

	entries []Entry
	byName  map[string]int
	blocks  []uint32
}

// Open reads the header, table of contents, and manifest. size is the length
// of the underlying archive, used to reject offsets that run past the end.
func Open(r io.ReaderAt, size int64) (*Archive, error) {
	hdr := make([]byte, headerSize)
	if _, err := r.ReadAt(hdr, 0); err != nil {
		return nil, fmt.Errorf("reading header: %w: %w", ErrCorrupt, err)
	}
	if string(hdr[0:4]) != magic {
		return nil, fmt.Errorf("%w: magic is %q, want %q", ErrNotPSARC, hdr[0:4], magic)
	}

	a := &Archive{
		r:            r,
		VersionMajor: binary.BigEndian.Uint16(hdr[4:6]),
		VersionMinor: binary.BigEndian.Uint16(hdr[6:8]),
		Compression:  string(hdr[8:12]),
		BlockSize:    binary.BigEndian.Uint32(hdr[24:28]),
	}
	tocLength := binary.BigEndian.Uint32(hdr[12:16])
	entrySize := binary.BigEndian.Uint32(hdr[16:20])
	entryCount := binary.BigEndian.Uint32(hdr[20:24])
	flags := binary.BigEndian.Uint32(hdr[28:32])

	if a.Compression != compZlib {
		return nil, fmt.Errorf("%w: compression %q, only %q is supported", ErrUnsupported, a.Compression, compZlib)
	}
	if flags&flagTOCEncrypted != 0 {
		return nil, fmt.Errorf("%w: table of contents is encrypted", ErrUnsupported)
	}
	if entrySize < 30 {
		return nil, fmt.Errorf("%w: toc entry size %d, want at least 30", ErrCorrupt, entrySize)
	}
	if entryCount == 0 {
		return nil, fmt.Errorf("%w: archive declares zero entries, but entry 0 is always the manifest", ErrCorrupt)
	}
	if a.BlockSize == 0 {
		return nil, fmt.Errorf("%w: block size is zero", ErrCorrupt)
	}
	if int64(tocLength) > size || int64(tocLength) < headerSize {
		return nil, fmt.Errorf("%w: toc length %d against archive size %d", ErrCorrupt, tocLength, size)
	}

	tocBytes := int64(entryCount) * int64(entrySize)
	if headerSize+tocBytes > int64(tocLength) {
		return nil, fmt.Errorf("%w: %d entries of %d bytes exceed toc length %d", ErrCorrupt, entryCount, entrySize, tocLength)
	}

	toc := make([]byte, tocLength-headerSize)
	if _, err := r.ReadAt(toc, headerSize); err != nil {
		return nil, fmt.Errorf("reading toc: %w: %w", ErrCorrupt, err)
	}

	a.entries = make([]Entry, entryCount)
	for i := range a.entries {
		b := toc[int64(i)*int64(entrySize):]
		a.entries[i] = Entry{
			// b[0:16] is the md5 of the path; we resolve names from the
			// manifest instead, so it is read past rather than stored.
			blockIndex:       binary.BigEndian.Uint32(b[16:20]),
			UncompressedSize: int64(read40(b[20:25])),
			startOffset:      int64(read40(b[25:30])),
		}
		if a.entries[i].startOffset > size {
			return nil, fmt.Errorf("%w: entry %d starts at %d, past archive end %d", ErrCorrupt, i, a.entries[i].startOffset, size)
		}
	}

	width := blockWidth(a.BlockSize)
	blockBytes := int64(tocLength) - headerSize - tocBytes
	if blockBytes < 0 || blockBytes%int64(width) != 0 {
		return nil, fmt.Errorf("%w: %d block-table bytes is not a multiple of %d", ErrCorrupt, blockBytes, width)
	}
	a.blocks = make([]uint32, blockBytes/int64(width))
	for i := range a.blocks {
		off := tocBytes + int64(i)*int64(width)
		a.blocks[i] = readN(toc[off : off+int64(width)])
	}

	if err := a.loadManifest(); err != nil {
		return nil, err
	}
	return a, nil
}

// loadManifest inflates entry 0 and assigns names to entries 1..n-1.
func (a *Archive) loadManifest() error {
	raw, err := a.readEntry(0)
	if err != nil {
		return fmt.Errorf("reading manifest: %w", err)
	}
	names := strings.FieldsFunc(string(raw), func(r rune) bool { return r == '\n' || r == '\r' })

	a.byName = make(map[string]int, len(names))
	for i, name := range names {
		name = strings.TrimPrefix(strings.TrimSpace(name), "/")
		if name == "" {
			continue
		}
		// Manifest line i names entry i+1; entry 0 is the manifest itself.
		if i+1 >= len(a.entries) {
			return fmt.Errorf("%w: manifest lists %d names for %d entries", ErrCorrupt, len(names), len(a.entries)-1)
		}
		a.entries[i+1].Name = name
		a.byName[name] = i + 1
	}
	return nil
}

// Names returns every path in the archive, in manifest order.
func (a *Archive) Names() []string {
	out := make([]string, 0, len(a.entries)-1)
	for _, e := range a.entries[1:] {
		if e.Name != "" {
			out = append(out, e.Name)
		}
	}
	return out
}

// Entries returns the archive's entries excluding the manifest.
func (a *Archive) Entries() []Entry {
	out := make([]Entry, len(a.entries)-1)
	copy(out, a.entries[1:])
	return out
}

// ReadFile decompresses one file by archive-relative path.
func (a *Archive) ReadFile(name string) ([]byte, error) {
	name = strings.TrimPrefix(name, "/")
	i, ok := a.byName[name]
	if !ok {
		return nil, fmt.Errorf("%w: %q", ErrNotFound, name)
	}
	b, err := a.readEntry(i)
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", name, err)
	}
	return b, nil
}

// readEntry walks an entry's block list, inflating each block until the
// declared uncompressed size is reached.
func (a *Archive) readEntry(i int) ([]byte, error) {
	e := a.entries[i]
	if e.UncompressedSize == 0 {
		return nil, nil
	}

	out := make([]byte, 0, e.UncompressedSize)
	offset := e.startOffset
	buf := make([]byte, a.BlockSize)

	for bi := e.blockIndex; int64(len(out)) < e.UncompressedSize; bi++ {
		if int(bi) >= len(a.blocks) {
			return nil, fmt.Errorf("%w: entry %d ran past the block table at index %d", ErrCorrupt, i, bi)
		}

		// A zero length means the block was stored whole and uncompressed,
		// except for a final block, which is only as long as what remains.
		n := int64(a.blocks[bi])
		if n == 0 {
			n = int64(a.BlockSize)
			if remaining := e.UncompressedSize - int64(len(out)); remaining < n {
				n = remaining
			}
		}

		chunk := buf[:n]
		if _, err := a.r.ReadAt(chunk, offset); err != nil {
			return nil, fmt.Errorf("%w: reading block %d at offset %d: %w", ErrCorrupt, bi, offset, err)
		}
		offset += n

		// A block is compressed or stored raw, and the format gives no flag
		// distinguishing them — only the bytes. A zlib header is the signal,
		// but ~1 raw block in 8000 opens with a byte pair that looks like
		// one by chance, so a failed inflate falls back to raw rather than
		// failing the read. zlib's adler32 makes a false positive that also
		// inflates cleanly vanishingly unlikely.
		if inflated, ok := tryInflate(chunk); ok {
			out = append(out, inflated...)
		} else {
			out = append(out, chunk...)
		}
	}

	if int64(len(out)) != e.UncompressedSize {
		return nil, fmt.Errorf("%w: entry %d produced %d bytes, declared %d", ErrCorrupt, i, len(out), e.UncompressedSize)
	}
	return out, nil
}

// tryInflate decompresses b when it is a zlib stream, reporting whether it
// was. It screens on the zlib header first — CMF 0x78 for a 32K window with
// the deflate method, and a FCHECK byte making the pair a multiple of 31 —
// then confirms by actually inflating, so a chance header match on raw data
// is rejected rather than mistaken for compressed content.
func tryInflate(b []byte) ([]byte, bool) {
	if len(b) < 2 || b[0] != 0x78 || (uint16(b[0])<<8|uint16(b[1]))%31 != 0 {
		return nil, false
	}
	zr, err := zlib.NewReader(bytes.NewReader(b))
	if err != nil {
		return nil, false
	}
	defer zr.Close()
	inflated, err := io.ReadAll(zr)
	if err != nil {
		return nil, false
	}
	return inflated, true
}

// read40 reads a 40-bit big-endian value. Sizes and offsets use five bytes
// rather than four so archives can exceed 4 GiB.
func read40(b []byte) uint64 {
	return uint64(b[0])<<32 | uint64(b[1])<<24 | uint64(b[2])<<16 | uint64(b[3])<<8 | uint64(b[4])
}

// readN reads a 1- to 4-byte big-endian value.
func readN(b []byte) uint32 {
	var v uint32
	for _, c := range b {
		v = v<<8 | uint32(c)
	}
	return v
}

// blockWidth is how many bytes each block-table value occupies. A stored
// length is always less than BlockSize, since a full block is written as 0,
// so the width is what it takes to hold BlockSize-1.
func blockWidth(blockSize uint32) int {
	switch {
	case blockSize <= 0x100:
		return 1
	case blockSize <= 0x10000:
		return 2
	case blockSize <= 0x1000000:
		return 3
	default:
		return 4
	}
}
