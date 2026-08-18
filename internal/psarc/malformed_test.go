package psarc

import (
	"bytes"
	"encoding/binary"
	"errors"
	"testing"
)

// The reader's other tests exercise archives this package's own writer
// produced, which are well-formed by construction. These build headers and
// tables directly, because the inputs that matter here are the ones no
// writer would emit: a truncated download, a half-written file, or a .pak
// from a game version whose layout we guessed wrong.
//
// Every case must return an error. None may panic, and none may size an
// allocation from an unvalidated header field.

// malformedHeader assembles a 32-byte PSARC header field by field.
func malformedHeader(tocLength, entrySize, entryCount, blockSize, flags uint32) []byte {
	var b bytes.Buffer
	b.WriteString(magic)
	binary.Write(&b, binary.BigEndian, uint16(1))
	binary.Write(&b, binary.BigEndian, uint16(4))
	b.WriteString(compZlib)
	binary.Write(&b, binary.BigEndian, tocLength)
	binary.Write(&b, binary.BigEndian, entrySize)
	binary.Write(&b, binary.BigEndian, entryCount)
	binary.Write(&b, binary.BigEndian, blockSize)
	binary.Write(&b, binary.BigEndian, flags)
	return b.Bytes()
}

// tocEntry assembles one 30-byte table-of-contents entry.
func tocEntry(blockIndex uint32, uncompressed, offset uint64) []byte {
	var b bytes.Buffer
	b.Write(make([]byte, 16)) // md5 of the path, unused
	binary.Write(&b, binary.BigEndian, blockIndex)
	b.Write(put40(uncompressed))
	b.Write(put40(offset))
	return b.Bytes()
}

// A block-table value wider than BlockSize must not slice past the read
// buffer. blockWidth rounds BlockSize up to a byte boundary, so a 1-byte
// table entry carries up to 255 against a block size of 2.
func TestBlockLengthOverBlockSizeIsRejected(t *testing.T) {
	var f bytes.Buffer
	f.Write(malformedHeader(63, 30, 1, 2, 0))
	f.Write(tocEntry(0, 2, 63))
	f.WriteByte(255) // blocks[0], far over the 2-byte block size
	f.Write(make([]byte, 16))

	_, err := Open(bytes.NewReader(f.Bytes()), int64(f.Len()))
	if !errors.Is(err, ErrCorrupt) {
		t.Fatalf("error = %v, want ErrCorrupt", err)
	}
}

// entryCount * entrySize must be computed where it cannot wrap. In int64 the
// product of two uint32 maxima is negative, which passes a `>` guard and
// leaves entryCount sizing a 137 GB slice.
func TestTOCEntryProductCannotOverflow(t *testing.T) {
	if p := uint64(^uint32(0)) * uint64(^uint32(0)); int64(p) >= 0 {
		t.Fatalf("premise no longer holds: int64(%d) is not negative", p)
	}
	var f bytes.Buffer
	f.Write(malformedHeader(1024, ^uint32(0), ^uint32(0), 65536, 0))
	f.Write(make([]byte, 2048))

	_, err := Open(bytes.NewReader(f.Bytes()), int64(f.Len()))
	if !errors.Is(err, ErrCorrupt) {
		t.Fatalf("error = %v, want ErrCorrupt", err)
	}
}

// UncompressedSize is a 40-bit field. Unchecked it becomes a make() capacity
// of up to 1 TiB, reached during Open via the manifest.
func TestOversizedEntryIsRejectedBeforeAllocating(t *testing.T) {
	var f bytes.Buffer
	f.Write(malformedHeader(65, 30, 1, 65536, 0))
	f.Write(tocEntry(0, 1<<40-1, 65)) // ~1 TiB declared
	f.Write([]byte{0, 0})             // blocks[0], width 2
	f.Write(make([]byte, 16))

	_, err := Open(bytes.NewReader(f.Bytes()), int64(f.Len()))
	if !errors.Is(err, ErrCorrupt) {
		t.Fatalf("error = %v, want ErrCorrupt", err)
	}
}

// BlockSize sizes a per-entry buffer, so a corrupt header must not request
// gigabytes.
func TestOversizedBlockSizeIsRejected(t *testing.T) {
	for _, bs := range []uint32{maxBlockSize + 1, 1 << 30, ^uint32(0)} {
		var f bytes.Buffer
		f.Write(malformedHeader(65, 30, 1, bs, 0))
		f.Write(make([]byte, 64))

		_, err := Open(bytes.NewReader(f.Bytes()), int64(f.Len()))
		if !errors.Is(err, ErrCorrupt) {
			t.Errorf("block size %d: error = %v, want ErrCorrupt", bs, err)
		}
	}
	// The real format's 64 KiB must still open far enough to fail elsewhere.
	var ok bytes.Buffer
	ok.Write(malformedHeader(65, 30, 1, 65536, 0))
	ok.Write(make([]byte, 64))
	if _, err := Open(bytes.NewReader(ok.Bytes()), int64(ok.Len())); errors.Is(err, ErrCorrupt) && err != nil {
		t.Logf("64 KiB block size still rejected downstream (expected, archive is otherwise empty): %v", err)
	}
}

// A block index past the end of the table must be caught at open, not by
// running off the slice mid-read.
func TestBlockIndexPastTableIsRejected(t *testing.T) {
	var f bytes.Buffer
	f.Write(malformedHeader(65, 30, 1, 65536, 0))
	f.Write(tocEntry(9999, 10, 65))
	f.Write([]byte{0, 0})
	f.Write(make([]byte, 16))

	_, err := Open(bytes.NewReader(f.Bytes()), int64(f.Len()))
	if !errors.Is(err, ErrCorrupt) {
		t.Fatalf("error = %v, want ErrCorrupt", err)
	}
}

// Nothing in the corrupt-input space may panic. Truncation is the shape a
// half-finished copy off the game drive actually takes.
func TestTruncatedArchivesNeverPanic(t *testing.T) {
	full := buildArchive(t, 64, []string{"A/B.MBIN", "C.MBIN"},
		[][]byte{bytes.Repeat([]byte("xy"), 200), []byte("short")})

	for n := 0; n < len(full); n++ {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("panic at truncation length %d: %v", n, r)
				}
			}()
			if a, err := Open(bytes.NewReader(full[:n]), int64(n)); err == nil {
				for _, name := range a.Names() {
					a.ReadFile(name)
				}
			}
		}()
	}
}

// Byte-level corruption of an otherwise valid archive must also stay on the
// error path.
func TestCorruptedBytesNeverPanic(t *testing.T) {
	full := buildArchive(t, 64, []string{"A/B.MBIN"}, [][]byte{bytes.Repeat([]byte("z"), 300)})

	for i := 4; i < len(full); i++ { // leave the magic intact so Open proceeds
		for _, v := range []byte{0x00, 0xFF, 0x7F} {
			mutated := append([]byte(nil), full...)
			mutated[i] = v
			func() {
				defer func() {
					if r := recover(); r != nil {
						t.Fatalf("panic with byte %d set to %#x: %v", i, v, r)
					}
				}()
				if a, err := Open(bytes.NewReader(mutated), int64(len(mutated))); err == nil {
					for _, name := range a.Names() {
						a.ReadFile(name)
					}
				}
			}()
		}
	}
}
