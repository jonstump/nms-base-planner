// Package domain holds the planner's computational core: dependency graph
// resolution, producer rollup, and power budgeting.
//
// Governing: ADR-0003 (Go/WASM domain core). This package MUST NOT import
// syscall/js — that boundary is what lets the ingestion CLI share it and what
// makes it testable under plain `go test`. If it erodes, the decision has
// failed even if the app works.
package domain

import "errors"

// Sentinel errors for the domain-specific failure modes callers need to
// distinguish programmatically.
//
// Governing: SPEC-0001 REQ "Error Handling Standards" — "Sentinel errors MUST
// be defined for domain-specific failure modes that callers need to
// distinguish programmatically — at minimum: unknown item, illegal method,
// cycle detected, and missing constant".
var (
	// ErrUnknownItem reports an item ID absent from the Tier 1 artifact.
	ErrUnknownItem = errors.New("unknown item")

	// ErrIllegalMethod reports a method requested for a node that has no
	// recipe of that kind, or a method outside the vocabulary entirely.
	ErrIllegalMethod = errors.New("illegal method")

	// ErrCycleDetected reports that method selection made a node its own
	// ancestor.
	ErrCycleDetected = errors.New("cycle detected")

	// ErrMissingConstant reports an absent Tier 2 economy constant. Stage 1
	// never returns it; it is defined here so the sentinel set is complete
	// and stable across stages.
	ErrMissingConstant = errors.New("missing constant")

	// ErrInvalidArtifact reports a Tier 1 artifact that failed structural
	// validation at load time.
	ErrInvalidArtifact = errors.New("invalid tier 1 artifact")
)
