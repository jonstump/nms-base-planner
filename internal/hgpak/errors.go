package hgpak

import (
	"errors"
	"fmt"
)

// Governing: ADR-0001 (two-tier NMS data ingestion), SPEC-0003 REQ "Error
// Handling Standards"
//
// Callers distinguish failure modes by sentinel, not by string matching. The
// five sentinels below are the complete set the spec requires. ErrUnsafePath
// is defined here but returned by the extraction layer (SPEC-0003 REQ "Safe
// Extraction to Disk"), so that the whole vocabulary lives in one place.
var (
	// ErrNotHGPAK means the file is not an HGPAK container at all. It is
	// deliberately distinct from ErrMalformed: a PSARC archive is a
	// well-formed file of the wrong kind, not a corrupt HGPAK.
	ErrNotHGPAK = errors.New("not an HGPAK archive")

	// ErrUnsupportedVersion means the container is HGPAK but a version this
	// reader does not implement. The format is reverse-engineered from one
	// game build, so a version bump is the expected shape of a game update
	// breaking us.
	ErrUnsupportedVersion = errors.New("unsupported HGPAK version")

	// ErrMalformed means the structure contradicts itself — a block that
	// decompresses to the wrong length, an entry running past the end of the
	// stream, a manifest disagreeing with the entry count.
	ErrMalformed = errors.New("malformed HGPAK archive")

	// ErrEntryNotFound means the requested entry does not exist.
	ErrEntryNotFound = errors.New("entry not found")

	// ErrUnsafePath means an archive path would resolve outside the
	// extraction directory. Archive paths are untrusted input.
	ErrUnsafePath = errors.New("unsafe extraction path")
)

// StructureError reports a structural contradiction with the fields needed to
// diagnose it. Fields are exposed rather than pre-formatted so a structured
// logger can emit them as key-value pairs instead of scraping a message
// string (SPEC-0003 REQ "Error Handling Standards").
type StructureError struct {
	// Op names the structural step that failed, e.g. "block table" or
	// "entry extent".
	Op string
	// Index is the block or entry ordinal involved, or -1 when not applicable.
	Index int
	// Want and Got carry the expectation that was violated.
	Want, Got any
	// Err is the sentinel this wraps, normally ErrMalformed.
	Err error
}

func (e *StructureError) Error() string {
	if e.Index >= 0 {
		return fmt.Sprintf("%s %d: got %v, want %v: %v", e.Op, e.Index, e.Got, e.Want, e.Err)
	}
	return fmt.Sprintf("%s: got %v, want %v: %v", e.Op, e.Got, e.Want, e.Err)
}

func (e *StructureError) Unwrap() error { return e.Err }

// LogAttrs returns the error's fields as alternating key-value pairs, ready
// to splat into a structured logger.
func (e *StructureError) LogAttrs() []any {
	attrs := []any{"op", e.Op, "want", e.Want, "got", e.Got}
	if e.Index >= 0 {
		attrs = append(attrs, "index", e.Index)
	}
	return attrs
}

func malformed(op string, index int, want, got any) error {
	return &StructureError{Op: op, Index: index, Want: want, Got: got, Err: ErrMalformed}
}
