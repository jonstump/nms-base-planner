package bridge

import (
	"errors"
	"fmt"

	"github.com/jonstump/nms-base-planner/internal/domain"
)

// The failure half of the boundary contract.
//
// Governing: SPEC-0002 REQ "Sentinel Error Preservation", REQ "Contract
// Versioning", REQ "Error Handling Standards"
//
// errors.Is does not survive a boundary crossing, and matching on message
// text is the classic brittle coupling: an improved error message silently
// breaks a consumer's branch. So each domain sentinel maps to a stable
// identifier the view switches on, and the Go message crosses alongside as
// diagnostic text with no contractual shape.

// Codes carried in an ErrorPayload.
//
// These are contract, not implementation detail: changing one is a contract
// version change per SPEC-0002 REQ "Contract Versioning". They are
// deliberately independent of the Go error text, so rewording a message
// never moves a code.
const (
	// From internal/domain's sentinel vocabulary.
	CodeUnknownItem     = "UNKNOWN_ITEM"
	CodeIllegalMethod   = "ILLEGAL_METHOD"
	CodeCycleDetected   = "CYCLE_DETECTED"
	CodeMissingConstant = "MISSING_CONSTANT"
	CodeInvalidArtifact = "INVALID_ARTIFACT"

	// Added by the boundary itself. The module can fail in ways the domain
	// has no vocabulary for, because the domain never had a lifecycle or a
	// caller on the other side of a wire.
	CodeNotReady        = "NOT_READY"
	CodeMalformedInput  = "MALFORMED_INPUT"
	CodeVersionMismatch = "VERSION_MISMATCH"

	// CodeUnclassified is reserved for an error matching no sentinel.
	//
	// The point, not a fallback: silently mapping an unrecognized error
	// onto the nearest sentinel makes the view branch confidently on a
	// wrong kind, which is worse than admitting ignorance.
	CodeUnclassified = "UNCLASSIFIED"
)

// sentinelCodes is the mapping, in match order.
//
// Ordered rather than a map because errors.Is is a predicate: an error can
// satisfy more than one sentinel if a future one wraps another, and a map's
// iteration order would make which code won depend on the run.
var sentinelCodes = []struct {
	sentinel error
	code     string
}{
	{domain.ErrUnknownItem, CodeUnknownItem},
	{domain.ErrIllegalMethod, CodeIllegalMethod},
	{domain.ErrCycleDetected, CodeCycleDetected},
	{domain.ErrMissingConstant, CodeMissingConstant},
	{domain.ErrInvalidArtifact, CodeInvalidArtifact},

	// Boundary-native failures, matched after the domain's so a wrapped
	// domain error is never shadowed by one of ours.
	{ErrNotReady, CodeNotReady},
	{ErrMalformedInput, CodeMalformedInput},
	{ErrVersionMismatch, CodeVersionMismatch},
}

// CodeFor returns the stable code for an error.
//
// Governing: SPEC-0002 REQ "Sentinel Error Preservation" — "Codes MUST be
// stable identifiers independent of Go error text — changing an error's
// message MUST NOT change its code."
//
// Matching is by errors.Is alone. Nothing here inspects message text, which
// is what makes the reworded-message scenario hold by construction rather
// than by discipline.
func CodeFor(err error) string {
	if err == nil {
		return ""
	}
	for _, m := range sentinelCodes {
		if errors.Is(err, m.sentinel) {
			return m.code
		}
	}
	return CodeUnclassified
}

// Boundary sentinels, for failure modes the domain has no vocabulary for.
//
// ErrNotReady is defined here with the rest of the code set but returned by
// the module lifecycle in #45 — the same split hgpak uses, where a sentinel
// lives with its siblings and the layer that can detect it returns it.
var (
	// ErrNotReady means the module was called before its artifact loaded.
	ErrNotReady = errors.New("module is not ready")

	// ErrMalformedInput means the caller's payload could not be decoded
	// into a valid plan. Distinct from an invalid artifact: the artifact is
	// ours, the input is theirs, and sending a user hunting through their
	// own payload for our bug is the failure this distinction prevents.
	ErrMalformedInput = errors.New("malformed input")

	// ErrVersionMismatch means the consumer was built against a different
	// contract version.
	ErrVersionMismatch = errors.New("contract version mismatch")
)

// FailureFrom builds a failure envelope from an error, mapping it to its
// stable code.
//
// Governing: SPEC-0002 REQ "Result Envelope", REQ "Sentinel Error
// Preservation"
func FailureFrom(err error) Envelope {
	if err == nil {
		// An error envelope with no error would be a lie in the other
		// direction; say so rather than emit an empty failure.
		return Failure(CodeUnclassified, "an error envelope was requested with no error")
	}
	return Failure(CodeFor(err), err.Error())
}

// CheckVersion compares the consumer's expected contract version against
// this module's.
//
// Governing: SPEC-0002 REQ "Contract Versioning" — "The consuming view MUST
// verify that version against the one it was built for, and MUST fail with
// a clear diagnostic on mismatch rather than proceeding against an
// unexpected shape."
//
// Both versions are named, because "version mismatch" alone tells a user
// nothing about which half to update.
func CheckVersion(expected string) error {
	if expected == ContractVersion {
		return nil
	}
	return fmt.Errorf("%w: the consumer expects %q, this module implements %q",
		ErrVersionMismatch, expected, ContractVersion)
}

// DecodePlanStrict decodes a plan and refuses anything it cannot turn into a
// valid input, naming what failed.
//
// Governing: SPEC-0002 REQ "Error Handling Standards" — "Decoding failures
// MUST name what could not be decoded and MUST NOT attempt computation."
//
// It returns a zero PlanInput on any failure, so a caller cannot
// accidentally compute against a half-decoded plan.
func DecodePlanStrict(p Plan) (domain.PlanInput, error) {
	if p.Target == "" {
		return domain.PlanInput{}, fmt.Errorf("%w: the plan names no target item", ErrMalformedInput)
	}
	in, err := DecodePlan(p)
	if err != nil {
		return domain.PlanInput{}, fmt.Errorf("%w: %v", ErrMalformedInput, err)
	}
	if in.Quantity <= 0 {
		return domain.PlanInput{}, fmt.Errorf("%w: quantity %q is not positive", ErrMalformedInput, p.Quantity)
	}
	for item, method := range in.Methods {
		if !method.Valid() {
			return domain.PlanInput{}, fmt.Errorf("%w: method %q selected for %q is not part of the vocabulary",
				ErrMalformedInput, method, item)
		}
	}
	return in, nil
}
