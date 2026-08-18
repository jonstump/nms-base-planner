// Package hgpak reads HGPAK archives — the container No Man's Sky ships its
// assets in under GAMEDATA/PCBANKS.
//
// Governing: ADR-0001 (two-tier NMS data ingestion) — stage 1 of the
// ingestion pipeline, "locate + extract PAKs". SPEC-0003 REQ "Container
// Identification", REQ "Structural Layout".
//
// The format was reverse-engineered from a real install (game files dated
// 2026-06-05) and every claim below was checked against actual archives, not
// against documentation. All integers are little-endian unsigned 64-bit
// except the entry hash, which is an opaque 16-byte value.
//
//	header      0x30 bytes: magic "HGPAK\0\0\0", version, entry count,
//	            block count, a storage flag, and the data-start offset
//	entries     entryCount * 32 bytes at 0x30; each is a 16-byte MD5 of the
//	            entry's lowercase path, a uint64 offset, and a uint64 size
//	blocks      blockCount * 8 bytes; each is one block's compressed length
//	data        the blocks themselves, each decompressing to exactly 65536
//	            bytes save a possibly-shorter final block, and each starting
//	            on a 16-byte boundary. A block is zstd unless its compressed
//	            length is exactly 65536, which means it is stored raw.
//
// Two details are easy to get wrong and both are load-bearing. Blocks are
// 16-byte aligned, so a reader that simply accumulates compressed lengths
// fails on the second block. And entry offsets address a *virtual image* of
// the file whose first dataStart bytes are the header and tables, so an
// entry's position in the decompressed stream is offset-dataStart, not
// offset. The committed fixture spans two blocks specifically so that both
// mistakes fail the test suite.
//
// The header field at 0x20 selects between two storage layouts. It is 1 in
// 95 of the install's 97 archives, which is the zstd block stream described
// above. It is 0 in NMSARC.audio.pak and NMSARC.audioBNK.pak, where the
// container is *stored*: there is no block table between the entry table and
// the data, dataStart is exactly headerSize+entryCount*32, entry offsets are
// direct file offsets, and entry bytes — manifest included — sit
// uncompressed. Audio archives hold already-compressed WEM/BNK payloads, so
// a second compression pass would buy nothing.
//
// SPEC-0003 REQ "Structural Layout" documents only the block-stream layout,
// because when it was written only two archives had been parsed in full and
// both were block-stream. The spec's own Open Questions section asked
// whether any archive used a different compression method; this is the
// answer, and the spec needs updating to record it.
//
// Entry 0 is the path manifest. This package exposes it as raw bytes;
// resolving entries by path is SPEC-0003 REQ "Manifest and Path Resolution".
package hgpak

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"io"

	"github.com/klauspost/compress/zstd"
)

const (
	// headerSize is the fixed size of the header preceding the entry table.
	headerSize = 0x30

	// entrySize is the size of one entry-table record: 16-byte hash, uint64
	// offset, uint64 size.
	entrySize = 32

	// BlockSize is the decompressed size of every block but the last. It is
	// fixed by the format, which is what makes random access pure
	// arithmetic: the entry at stream position p starts in block
	// p/BlockSize.
	BlockSize = 65536

	// blockAlign is the boundary each compressed block starts on.
	blockAlign = 16

	// SupportedVersion is the only container version this reader implements.
	SupportedVersion = 2

	// StorageBlocks is the header 0x20 value for a zstd block stream.
	StorageBlocks = 1
	// StorageStored is the header 0x20 value for uncompressed storage.
	StorageStored = 0
)

// magic is the 8-byte signature every HGPAK archive begins with.
var magic = [8]byte{'H', 'G', 'P', 'A', 'K', 0, 0, 0}

// Entry is one file in the archive.
type Entry struct {
	// Hash is the MD5 of the entry's lowercase path. Verifying it against
	// the manifest is SPEC-0003 REQ "Manifest and Path Resolution".
	Hash [16]byte
	// Offset is the entry's position in the virtual image of the file. Use
	// StreamPos for its position within the decompressed stream.
	Offset uint64
	// Size is the entry's length in bytes.
	Size uint64
}

// Archive is an opened HGPAK container. Entry contents are read on demand;
// opening an archive does not materialize its decompressed stream.
type Archive struct {
	r    io.ReaderAt
	size int64

	version   uint64
	storage   uint64
	dataStart uint64

	entries []Entry

	// blockLen[i] is block i's compressed length; blockPos[i] is its
	// absolute offset in the file, already 16-byte aligned.
	blockLen []uint64
	blockPos []int64

	// streamLen is the total decompressed length of all blocks.
	streamLen uint64

	dec *zstd.Decoder
}

// StreamPos returns the entry's position within the concatenated
// decompressed stream. Entry offsets are relative to a virtual image of the
// file whose first dataStart bytes are the header and tables. For stored
// archives the "stream" is the file itself, so this is still offset-dataStart
// and still zero for entry 0.
func (a *Archive) StreamPos(e Entry) uint64 { return e.Offset - a.dataStart }

// Version returns the container version.
func (a *Archive) Version() uint64 { return a.version }

// Storage reports the container's storage layout: StorageBlocks for a zstd
// block stream, StorageStored for uncompressed storage.
func (a *Archive) Storage() uint64 { return a.storage }

// Stored reports whether entry bytes are stored uncompressed, in which case
// there is no block layer and Block always fails.
func (a *Archive) Stored() bool { return a.storage == StorageStored }

// DataStart returns the file offset where the compressed blocks begin.
func (a *Archive) DataStart() uint64 { return a.dataStart }

// Len returns the number of entries, including the manifest at index 0.
func (a *Archive) Len() int { return len(a.entries) }

// BlockCount returns the number of compressed blocks.
func (a *Archive) BlockCount() int { return len(a.blockLen) }

// StreamLen returns the total decompressed length of the block stream.
func (a *Archive) StreamLen() uint64 { return a.streamLen }

// Entries returns a copy of the entry table.
func (a *Archive) Entries() []Entry {
	out := make([]Entry, len(a.entries))
	copy(out, a.entries)
	return out
}

// Entry returns the entry at index i.
func (a *Archive) Entry(i int) (Entry, error) {
	if i < 0 || i >= len(a.entries) {
		return Entry{}, fmt.Errorf("entry %d of %d: %w", i, len(a.entries), ErrEntryNotFound)
	}
	return a.entries[i], nil
}

// Open reads an archive's header and tables. It does not decompress any
// block, so opening a 47 MB archive that decompresses to ~565 MB is cheap.
func Open(r io.ReaderAt, size int64) (*Archive, error) {
	if size < headerSize {
		return nil, fmt.Errorf("file is %d bytes, shorter than a %d-byte header: %w", size, headerSize, ErrNotHGPAK)
	}

	var hdr [headerSize]byte
	if _, err := r.ReadAt(hdr[:], 0); err != nil {
		return nil, fmt.Errorf("reading header: %w", err)
	}

	// Identify the container before interpreting any other field, and report
	// what was actually found — a PSARC archive must be diagnosable as such
	// rather than as generic corruption.
	if !bytes.Equal(hdr[:8], magic[:]) {
		return nil, fmt.Errorf("magic is %q, want %q: %w",
			printableMagic(hdr[:8]), "HGPAK", ErrNotHGPAK)
	}

	a := &Archive{r: r, size: size}
	a.version = binary.LittleEndian.Uint64(hdr[0x08:])
	entryCount := binary.LittleEndian.Uint64(hdr[0x10:])
	blockCount := binary.LittleEndian.Uint64(hdr[0x18:])
	a.storage = binary.LittleEndian.Uint64(hdr[0x20:])
	a.dataStart = binary.LittleEndian.Uint64(hdr[0x28:])

	if a.version != SupportedVersion {
		return nil, fmt.Errorf("version %d (this reader implements %d): %w",
			a.version, SupportedVersion, ErrUnsupportedVersion)
	}

	if a.storage != StorageBlocks && a.storage != StorageStored {
		return nil, malformed("storage flag", -1,
			fmt.Sprintf("%d (blocks) or %d (stored)", StorageBlocks, StorageStored), a.storage)
	}

	// Bound the table sizes against the file before allocating: a corrupt
	// count must not turn into a multi-gigabyte make().
	if entryCount == 0 {
		return nil, malformed("entry count", -1, ">= 1 (entry 0 is the manifest)", 0)
	}
	if entryCount > uint64(size)/entrySize {
		return nil, malformed("entry count", -1, fmt.Sprintf("<= %d for a %d-byte file", uint64(size)/entrySize, size), entryCount)
	}

	// A stored archive carries no block table between the entry table and
	// the data, so its tables end sooner.
	tableEnd := uint64(headerSize) + entryCount*entrySize
	if a.storage == StorageBlocks {
		if blockCount > uint64(size)/8 {
			return nil, malformed("block count", -1, fmt.Sprintf("<= %d for a %d-byte file", uint64(size)/8, size), blockCount)
		}
		tableEnd += blockCount * 8
	}
	if tableEnd > uint64(size) {
		return nil, malformed("table extent", -1,
			fmt.Sprintf("<= file size %d", size), tableEnd)
	}
	if a.dataStart > uint64(size) || a.dataStart < tableEnd {
		return nil, malformed("data start", -1,
			fmt.Sprintf("in [%d, %d]", tableEnd, size), a.dataStart)
	}

	if err := a.readTables(entryCount, blockCount); err != nil {
		return nil, err
	}

	dec, err := zstd.NewReader(nil)
	if err != nil {
		return nil, fmt.Errorf("creating zstd decoder: %w", err)
	}
	a.dec = dec

	return a, nil
}

// readTables parses the entry table and the block table, and derives each
// block's aligned physical offset.
func (a *Archive) readTables(entryCount, blockCount uint64) error {
	buf := make([]byte, entryCount*entrySize)
	if _, err := a.r.ReadAt(buf, headerSize); err != nil {
		return fmt.Errorf("reading entry table: %w", err)
	}
	a.entries = make([]Entry, entryCount)
	for i := range a.entries {
		rec := buf[i*entrySize:]
		copy(a.entries[i].Hash[:], rec[:16])
		a.entries[i].Offset = binary.LittleEndian.Uint64(rec[16:])
		a.entries[i].Size = binary.LittleEndian.Uint64(rec[24:])
	}

	if a.storage == StorageStored {
		// Stored archives address entry bytes by direct file offset, so the
		// whole file past the header is the "stream" and there is no block
		// layer to build. blockCount is left unparsed: no block table exists
		// in the region between the entry table and the data, and nothing in
		// the ingestion pipeline needs whatever it counts.
		a.streamLen = uint64(a.size) - a.dataStart
		return nil
	}

	blockBuf := make([]byte, blockCount*8)
	if _, err := a.r.ReadAt(blockBuf, headerSize+int64(entryCount)*entrySize); err != nil {
		return fmt.Errorf("reading block table: %w", err)
	}
	a.blockLen = make([]uint64, blockCount)
	a.blockPos = make([]int64, blockCount)

	// Blocks start on 16-byte boundaries. Accumulating compressed lengths
	// without re-aligning lands mid-frame on the second block, which is the
	// single most likely way to get this format wrong.
	pos := int64(a.dataStart)
	for i := range a.blockLen {
		n := binary.LittleEndian.Uint64(blockBuf[i*8:])
		if n == 0 {
			return malformed("block length", i, "> 0", 0)
		}
		if pos+int64(n) > a.size {
			return malformed("block extent", i,
				fmt.Sprintf("<= file size %d", a.size), pos+int64(n))
		}
		a.blockLen[i] = n
		a.blockPos[i] = pos
		pos += int64(n)
		if rem := pos % blockAlign; rem != 0 {
			pos += blockAlign - rem
		}
	}

	// Every block but the last decompresses to exactly BlockSize, so the
	// stream length is known without decompressing anything. The final
	// block may be short; the exact total is settled when it is read.
	if blockCount > 0 {
		a.streamLen = (blockCount - 1) * BlockSize
		last, err := a.block(int(blockCount) - 1)
		if err != nil {
			return err
		}
		a.streamLen += uint64(len(last))
	}
	return nil
}

// block decompresses block i and verifies its length against the format's
// fixed decompressed block size.
func (a *Archive) block(i int) ([]byte, error) {
	if a.storage == StorageStored {
		return nil, fmt.Errorf("archive is stored uncompressed and has no blocks: %w", ErrEntryNotFound)
	}
	if i < 0 || i >= len(a.blockLen) {
		return nil, fmt.Errorf("block %d of %d: %w", i, len(a.blockLen), ErrEntryNotFound)
	}
	raw := make([]byte, a.blockLen[i])
	if _, err := a.r.ReadAt(raw, a.blockPos[i]); err != nil {
		return nil, fmt.Errorf("reading block %d at %d: %w", i, a.blockPos[i], err)
	}
	dec := a.dec
	if dec == nil {
		// readTables probes the final block before the shared decoder
		// exists; a throwaway decoder keeps that path honest.
		d, err := zstd.NewReader(nil)
		if err != nil {
			return nil, fmt.Errorf("creating zstd decoder: %w", err)
		}
		defer d.Close()
		dec = d
	}
	// A block whose compressed length is exactly BlockSize is stored raw.
	// This is a deterministic length rule, not a magic sniff: the packer
	// stores a block verbatim when compressing it would not pay, and the
	// stored length then equals the decompressed length by definition. It is
	// NOT the PSARC-style "try to inflate and fall back on failure" — a
	// block that claims to be compressed and then fails to decompress is
	// still an unambiguous structural error.
	if a.blockLen[i] == BlockSize {
		return raw, nil
	}
	out, err := dec.DecodeAll(raw, nil)
	if err != nil {
		return nil, fmt.Errorf("decompressing block %d: %w: %w", i, err, ErrMalformed)
	}
	// The last block is allowed to be short; every other block must be
	// exactly BlockSize or our block-index arithmetic is wrong.
	if i < len(a.blockLen)-1 && len(out) != BlockSize {
		return nil, malformed("block decompressed length", i, BlockSize, len(out))
	}
	if len(out) > BlockSize {
		return nil, malformed("block decompressed length", i, fmt.Sprintf("<= %d", BlockSize), len(out))
	}
	return out, nil
}

// Block returns block i's decompressed bytes.
func (a *Archive) Block(i int) ([]byte, error) { return a.block(i) }

// ReadEntry returns the bytes of entry i, decompressing only the blocks that
// entry spans.
func (a *Archive) ReadEntry(i int) ([]byte, error) {
	e, err := a.Entry(i)
	if err != nil {
		return nil, err
	}
	if e.Offset < a.dataStart {
		return nil, malformed("entry offset", i,
			fmt.Sprintf(">= dataStart %d", a.dataStart), e.Offset)
	}
	pos := a.StreamPos(e)
	end := pos + e.Size
	if end > a.streamLen {
		return nil, malformed("entry extent", i,
			fmt.Sprintf("<= stream length %d", a.streamLen), end)
	}

	if a.storage == StorageStored {
		out := make([]byte, e.Size)
		if _, err := a.r.ReadAt(out, int64(e.Offset)); err != nil {
			return nil, fmt.Errorf("reading entry %d at %d: %w", i, e.Offset, err)
		}
		return out, nil
	}

	out := make([]byte, 0, e.Size)
	for idx := pos / BlockSize; uint64(len(out)) < e.Size; idx++ {
		blk, err := a.block(int(idx))
		if err != nil {
			return nil, fmt.Errorf("entry %d: %w", i, err)
		}
		lo := uint64(0)
		if idx == pos/BlockSize {
			lo = pos % BlockSize
		}
		if lo > uint64(len(blk)) {
			return nil, malformed("entry extent", i,
				fmt.Sprintf("offset within block %d", idx), lo)
		}
		hi := uint64(len(blk))
		if remaining := e.Size - uint64(len(out)); hi-lo > remaining {
			hi = lo + remaining
		}
		out = append(out, blk[lo:hi]...)
	}
	return out, nil
}

// Manifest returns entry 0's raw bytes — the CRLF-separated path list.
// Parsing it into paths is SPEC-0003 REQ "Manifest and Path Resolution".
func (a *Archive) Manifest() ([]byte, error) {
	return a.ReadEntry(0)
}

// Close releases the zstd decoder.
func (a *Archive) Close() error {
	if a.dec != nil {
		a.dec.Close()
		a.dec = nil
	}
	return nil
}

// printableMagic renders a magic value for an error message, keeping ASCII
// readable so "PSAR" is recognizable at a glance.
func printableMagic(b []byte) string {
	end := len(b)
	for i, c := range b {
		if c < 0x20 || c > 0x7e {
			end = i
			break
		}
	}
	return string(b[:end])
}
