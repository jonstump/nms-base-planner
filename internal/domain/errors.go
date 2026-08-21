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

	// ErrMissingConstant reports an absent Tier 2 economy constant — a
	// curated scalar the caller did not supply, or an economy value the
	// artifact carries no usable figure for.
	//
	// Governing: SPEC-0001 REQ "Error Handling Standards" — Scenario
	// "Missing constant is distinguishable".
	//
	// Distinct from ErrUnknownItem, which reports a looked-up name that does
	// not exist, and from ErrInvalidArtifact, which reports data that is
	// structurally wrong. The distinction is what lets a caller tell "you
	// did not configure this" from "our artifact is broken" — the same
	// classification-by-context the boundary's Load path preserves.
	//
	// Stage 1 never returns it; stages 2 and 3 do.
	ErrMissingConstant = errors.New("missing constant")

	// ErrInvalidArtifact reports a Tier 1 artifact that failed structural
	// validation at load time.
	ErrInvalidArtifact = errors.New("invalid tier 1 artifact")
)
