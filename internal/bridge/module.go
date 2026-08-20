package bridge

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"

	"github.com/jonstump/nms-base-planner/internal/domain"
)

// The module's surface and lifecycle, in a form that needs no WASM build.
//
// Governing: ADR-0003 (Go domain, thin adapter), SPEC-0002 REQ "Boundary
// Surface", REQ "Module Lifecycle and Readiness", REQ "Event Loop Safety"
//
// Everything the boundary decides lives here: what the entry points are,
// when they are callable, and what comes back. The syscall/js shim in
// cmd/planner does nothing but hand strings across, so the interesting
// behaviour is testable under plain go test and the js half stays too small
// to hide a bug in.

// Module is the boundary's stateful half: it holds the loaded artifact and
// gates the entry points on it.
//
// Instantiation and artifact loading are distinct steps, per SPEC-0002 REQ
// "Module Lifecycle and Readiness" — a module that exists but has no data is
// a different failure from a module that failed to load, and conflating them
// sends a user to the wrong place.
type Module struct {
	mu       sync.RWMutex
	artifact *domain.Tier1
}

// NewModule creates an unloaded module. It is not ready until Load succeeds.
func NewModule() *Module { return &Module{} }

// Ready reports whether an artifact has been loaded.
func (m *Module) Ready() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.artifact != nil
}

// Load validates a Tier 1 artifact and makes the module ready.
//
// A validation failure is reported as an invalid artifact rather than as a
// module load failure: the module instantiated fine, and the data is what is
// wrong.
//
// Governing: SPEC-0002 REQ "Module Lifecycle and Readiness" — Scenario "A
// bad artifact is not a module failure".
func (m *Module) Load(artifactJSON string) Envelope {
	a1, err := domain.LoadTier1(strings.NewReader(artifactJSON))
	if err != nil {
		// Classified as an artifact problem by *context*, not by whichever
		// sentinel the error happens to wrap first.
		//
		// The domain double-wraps some validation failures — a recipe
		// naming an item no table defines is both ErrInvalidArtifact and
		// ErrUnknownItem — and CodeFor would return the more specific one.
		// That is right when a *plan* names a missing item, which is the
		// caller's problem. It is wrong here: anything that fails while
		// loading our own artifact is our data being inconsistent, and a
		// view told UNKNOWN_ITEM would send the user looking at their plan.
		//
		// Governing: SPEC-0002 REQ "Module Lifecycle and Readiness" — "the
		// failure is reported as an invalid-artifact error".
		return Failure(CodeInvalidArtifact, err.Error())
	}
	m.mu.Lock()
	m.artifact = a1
	m.mu.Unlock()
	return Success(ResultPayload{})
}

// Resolve runs stage 1 and returns one envelope carrying the whole graph.
//
// Governing: SPEC-0002 REQ "Boundary Surface" — "coarse-grained so one call
// performs one complete stage". The view gets every node from this single
// value; there is no per-node accessor to cross the boundary again for.
func (m *Module) Resolve(planJSON string) Envelope {
	artifact, ok := m.loaded()
	if !ok {
		return FailureFrom(fmt.Errorf("resolve: %w", ErrNotReady))
	}

	var plan Plan
	if err := json.Unmarshal([]byte(planJSON), &plan); err != nil {
		return FailureFrom(fmt.Errorf("%w: %v", ErrMalformedInput, err))
	}
	in, err := DecodePlanStrict(plan)
	if err != nil {
		return FailureFrom(err)
	}

	graph, err := domain.Resolve(artifact, in)
	if err != nil {
		return FailureFrom(err)
	}
	wire, err := EncodeGraph(graph)
	if err != nil {
		return FailureFrom(err)
	}
	return Success(ResultPayload{Graph: wire})
}

// Rollup runs stage 2 and returns one envelope carrying every base's
// construction instructions.
//
// Governing: SPEC-0002 REQ "Boundary Surface" — "WHEN rollup or power is
// added in a later stage THEN it accepts and returns the same envelope
// shape defined by REQ 'Result Envelope', with no bespoke calling
// convention." The signature, the envelope and the error vocabulary are
// Resolve's, unchanged.
//
// The stage resolves the plan itself rather than accepting a graph the
// caller hands back. REQ "Boundary Surface" requires one call to perform
// one complete stage, and a caller obliged to return a previous result
// would be assembling this one out of two crossings.
func (m *Module) Rollup(requestJSON string) Envelope {
	artifact, ok := m.loaded()
	if !ok {
		return FailureFrom(fmt.Errorf("rollup: %w", ErrNotReady))
	}

	var req RollupRequest
	if err := json.Unmarshal([]byte(requestJSON), &req); err != nil {
		return FailureFrom(fmt.Errorf("%w: %v", ErrMalformedInput, err))
	}
	plan, err := DecodePlanStrict(req.Plan)
	if err != nil {
		return FailureFrom(err)
	}
	curated, err := DecodeCurated(req.Constants)
	if err != nil {
		return FailureFrom(err)
	}
	grouping, err := DecodeRollupInput(req)
	if err != nil {
		return FailureFrom(err)
	}
	producers, err := DecodeProducerInput(req)
	if err != nil {
		return FailureFrom(err)
	}

	constants, err := domain.NewConstants(artifact, curated)
	if err != nil {
		return FailureFrom(err)
	}
	graph, err := domain.Resolve(artifact, plan)
	if err != nil {
		return FailureFrom(err)
	}
	grouped, err := domain.GroupLeaves(graph, grouping)
	if err != nil {
		return FailureFrom(err)
	}
	build, err := domain.RollupProducers(grouped, artifact, constants, producers)
	if err != nil {
		return FailureFrom(err)
	}
	wire, err := EncodeBuild(build, grouped)
	if err != nil {
		return FailureFrom(err)
	}
	return Success(ResultPayload{Build: wire})
}

// Power runs stage 3 and returns one envelope carrying every base's power
// position.
//
// Governing: SPEC-0002 REQ "Boundary Surface"
//
// It takes no plan. The domain's power stage costs a set of counts, not a
// resolved graph — the same figures whether they came from a rollup or from
// a caller sketching a base by hand — so requiring a plan here would invent
// a coupling the engine does not have. It still requires a loaded artifact,
// because the parts and hotspot strengths it reads live in the artifact's
// economy section.
func (m *Module) Power(requestJSON string) Envelope {
	artifact, ok := m.loaded()
	if !ok {
		return FailureFrom(fmt.Errorf("power: %w", ErrNotReady))
	}

	var req PowerRequest
	if err := json.Unmarshal([]byte(requestJSON), &req); err != nil {
		return FailureFrom(fmt.Errorf("%w: %v", ErrMalformedInput, err))
	}
	curated, err := DecodeCurated(req.Constants)
	if err != nil {
		return FailureFrom(err)
	}
	in, err := DecodePowerInput(req)
	if err != nil {
		return FailureFrom(err)
	}

	constants, err := domain.NewConstants(artifact, curated)
	if err != nil {
		return FailureFrom(err)
	}
	budgets, err := domain.ComputePower(constants, in)
	if err != nil {
		return FailureFrom(err)
	}
	wire, err := EncodePower(budgets)
	if err != nil {
		return FailureFrom(err)
	}
	return Success(ResultPayload{Power: wire})
}

// loaded returns the artifact under a read lock.
func (m *Module) loaded() (*domain.Tier1, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.artifact, m.artifact != nil
}

// EntryPoints are the names the namespace object carries.
//
// Governing: SPEC-0002 REQ "Boundary Surface" — one named entry point per
// domain stage, on a single namespace object, with nothing state-mutating
// beyond the lifecycle.
//
// Enumerated here rather than inline in the js shim so the surface is
// listable from a plain test, and so adding one is a change to this list
// rather than a change scattered through registration code.
var EntryPoints = []string{"load", "ready", "resolve", "rollup", "power"}

// Namespace is the single global name the module registers under.
const Namespace = "nmsPlanner"

// Call dispatches a named entry point.
//
// The js shim does nothing but pass a name and a string through here, which
// is what keeps it thin enough to be uninteresting.
func (m *Module) Call(name, arg string) Envelope {
	switch name {
	case "load":
		return m.Load(arg)
	case "ready":
		if !m.Ready() {
			return FailureFrom(fmt.Errorf("module: %w", ErrNotReady))
		}
		return Success(ResultPayload{})
	case "resolve":
		return m.Resolve(arg)
	case "rollup":
		return m.Rollup(arg)
	case "power":
		return m.Power(arg)
	default:
		return Failure(CodeMalformedInput,
			fmt.Sprintf("%q is not an entry point on %s; expected one of %v", name, Namespace, EntryPoints))
	}
}

// CallJSON dispatches and marshals in one step, which is the whole of what
// the js shim needs.
func (m *Module) CallJSON(name, arg string) string {
	blob, err := Marshal(m.Call(name, arg))
	if err != nil {
		// Marshalling an envelope cannot fail on any value this package
		// builds, but returning a bare Go error string across the boundary
		// would break the contract the view parses against.
		return `{"ok":false,"contractVersion":"` + ContractVersion +
			`","error":{"code":"` + CodeUnclassified + `","message":"envelope could not be marshalled"}}`
	}
	return string(blob)
}
