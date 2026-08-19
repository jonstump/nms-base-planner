// Package normalize turns decompiled No Man's Sky tables into the Tier 1
// artifact the planner loads.
//
// Governing: ADR-0001 (two-tier NMS data ingestion) — the Tier 1 producer.
// SPEC-0004 REQ "Structural Surprise Fails Loudly", REQ "Error Handling
// Standards".
//
// The posture throughout is fail-closed. The source tables are decompiled
// from a reverse-engineered format that one game update can move, and a
// normalizer that skips an unparseable row emits a quietly smaller recipe
// graph — which surfaces much later as a wrong tree in the planner, with no
// obvious cause. A named error at generation is the cheap failure; a
// plausible-looking artifact is the expensive one.
package normalize

import (
	"errors"
	"fmt"
)

// Sentinels for the failure modes a caller needs to tell apart.
//
// Governing: SPEC-0004 REQ "Error Handling Standards"
var (
	// ErrSourceMissing means an expected source table or archive is absent.
	// Usually a wrong path or an incomplete extraction, not corrupt data.
	ErrSourceMissing = errors.New("source table missing")

	// ErrStructureUnrecognized means a table is present but does not match
	// the structure this normalizer expects — a missing field, an
	// unrecognized enum. The expected shape of a game update breaking us.
	ErrStructureUnrecognized = errors.New("source structure unrecognized")

	// ErrReferenceUnresolved means one record points at another that is not
	// there — a recipe input naming an item no table defines.
	ErrReferenceUnresolved = errors.New("reference unresolved")

	// ErrLocalisationUnresolved means a name key did not resolve in the
	// localisation tables. Distinct from ErrReferenceUnresolved because the
	// remedy differs: this one usually means the wrong language tables were
	// read, not that the data is inconsistent.
	ErrLocalisationUnresolved = errors.New("localisation key unresolved")
)

// SourceError reports a problem with a specific place in a specific source
// table. Fields are exposed rather than pre-formatted so a structured logger
// can emit them as key-value pairs instead of scraping a message string.
//
// Mirrors the shape of hgpak.StructureError deliberately: the two packages
// sit next to each other in one pipeline, and a caller that has learned to
// read one should not have to learn a second vocabulary.
type SourceError struct {
	// Table names the source table, e.g. "nms_reality_gcproducttable".
	Table string
	// Row identifies the record within it, e.g. "ULTRAPROD2". Empty when
	// the fault is with the table as a whole.
	Row string
	// Field names the specific field at fault, when there is one.
	Field string
	// Want and Got carry the expectation that was violated.
	Want, Got any
	// Err is the sentinel this wraps.
	Err error
}

func (e *SourceError) Error() string {
	loc := e.Table
	if e.Row != "" {
		loc += ": " + e.Row
	}
	if e.Field != "" {
		loc += ": " + e.Field
	}
	if e.Want == nil && e.Got == nil {
		return fmt.Sprintf("%s: %v", loc, e.Err)
	}
	return fmt.Sprintf("%s: got %v, want %v: %v", loc, e.Got, e.Want, e.Err)
}

func (e *SourceError) Unwrap() error { return e.Err }

// LogAttrs returns the error's fields as alternating key-value pairs, ready
// to splat into a structured logger.
func (e *SourceError) LogAttrs() []any {
	attrs := []any{"table", e.Table}
	if e.Row != "" {
		attrs = append(attrs, "row", e.Row)
	}
	if e.Field != "" {
		attrs = append(attrs, "field", e.Field)
	}
	if e.Want != nil {
		attrs = append(attrs, "want", e.Want)
	}
	if e.Got != nil {
		attrs = append(attrs, "got", e.Got)
	}
	return append(attrs, "cause", e.Err.Error())
}

// Missing reports an absent source table.
func Missing(table string) error {
	return &SourceError{Table: table, Err: ErrSourceMissing}
}

// Unrecognized reports a table whose structure does not match expectation.
func Unrecognized(table, row, field string, want, got any) error {
	return &SourceError{Table: table, Row: row, Field: field, Want: want, Got: got, Err: ErrStructureUnrecognized}
}

// Unresolved reports a record referencing something no table defines.
func Unresolved(table, row, field string, got any) error {
	return &SourceError{Table: table, Row: row, Field: field, Got: got, Err: ErrReferenceUnresolved}
}

// UnresolvedName reports a name key absent from the localisation tables.
func UnresolvedName(table, row string, key string) error {
	return &SourceError{Table: table, Row: row, Field: "name", Got: key, Err: ErrLocalisationUnresolved}
}
