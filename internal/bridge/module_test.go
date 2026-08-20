package bridge_test

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jonstump/nms-base-planner/internal/bridge"
)

func fixtureJSON(t *testing.T) string {
	t.Helper()
	blob, err := os.ReadFile("../domain/testdata/stasis-device.tier1.json")
	if err != nil {
		t.Fatalf("reading the fixture: %v", err)
	}
	return string(blob)
}

func loadedModule(t *testing.T) *bridge.Module {
	t.Helper()
	m := bridge.NewModule()
	if env := m.Load(fixtureJSON(t)); !env.OK {
		t.Fatalf("loading the fixture: %+v", env.Error)
	}
	return m
}

// SPEC-0002 REQ "Boundary Surface":
// WHEN the module has initialized THEN exactly one namespace object is
// registered, carrying the stage entry points, and no domain function is
// reachable from the global scope directly.
//
// The registration itself is three lines of syscall/js in cmd/planner; what
// is worth testing is the surface it registers, which is enumerated here.
func TestSurfaceIsOneNamespaceWithNamedEntryPoints(t *testing.T) {
	if bridge.Namespace == "" {
		t.Fatal("no namespace name")
	}
	if len(bridge.EntryPoints) == 0 {
		t.Fatal("no entry points enumerated")
	}

	seen := map[string]bool{}
	for _, name := range bridge.EntryPoints {
		if seen[name] {
			t.Errorf("entry point %q is listed twice", name)
		}
		seen[name] = true
	}
	// The stages the spec requires and reserves.
	for _, required := range []string{"load", "ready", "resolve", "rollup", "power"} {
		if !seen[required] {
			t.Errorf("entry point %q is missing", required)
		}
	}

	// Every name dispatches to something that returns a well-formed
	// envelope — no name is registered that would return undefined.
	m := loadedModule(t)
	for _, name := range bridge.EntryPoints {
		var env bridge.Envelope
		if err := json.Unmarshal([]byte(m.CallJSON(name, "{}")), &env); err != nil {
			t.Errorf("%s returned unparseable output: %v", name, err)
			continue
		}
		if env.ContractVersion != bridge.ContractVersion {
			t.Errorf("%s returned contract version %q", name, env.ContractVersion)
		}
		if env.OK == (env.Error != nil) {
			t.Errorf("%s returned ok=%v with error=%v — exactly one must hold", name, env.OK, env.Error)
		}
	}

	// An unknown name is a named failure rather than undefined.
	var env bridge.Envelope
	if err := json.Unmarshal([]byte(m.CallJSON("resolveAll", "{}")), &env); err != nil {
		t.Fatal(err)
	}
	if env.OK {
		t.Error("an unknown entry point reported success")
	}
	if !strings.Contains(env.Error.Message, "resolveAll") {
		t.Errorf("message %q does not name the entry point that does not exist", env.Error.Message)
	}
}

// SPEC-0002 REQ "Boundary Surface":
// WHEN the view resolves a plan and renders 34 nodes THEN exactly one
// boundary crossing occurred, and node data was read from the single
// returned value.
func TestResolvingCrossesTheBoundaryOnce(t *testing.T) {
	m := loadedModule(t)

	// One call, one string back, everything in it.
	out := m.CallJSON("resolve", `{"target":"sd","quantity":"1"}`)
	var env bridge.Envelope
	if err := json.Unmarshal([]byte(out), &env); err != nil {
		t.Fatalf("parsing the envelope: %v", err)
	}
	if !env.OK {
		t.Fatalf("resolve failed: %+v", env.Error)
	}
	if env.Data == nil || env.Data.Graph == nil {
		t.Fatal("no graph in the payload")
	}
	if got := len(env.Data.Graph.Nodes); got != 34 {
		t.Errorf("nodes = %d, want the fixture's 34", got)
	}

	// Every node's data is present in that one value: no second crossing
	// would be needed to render any of it.
	for _, n := range env.Data.Graph.Nodes {
		if n.ItemID == "" || n.Name == "" || n.Total == "" {
			t.Errorf("node %+v is missing data the view would have to fetch separately", n)
		}
		if !n.Terminal && len(n.LegalRecipes) == 0 {
			t.Errorf("node %s carries no legal recipes; the view would need the artifact", n.ItemID)
		}
	}
}

// SPEC-0002 REQ "Module Lifecycle and Readiness":
// WHEN an entry point is called before the readiness signal has resolved
// THEN it returns a failure envelope with the not-ready code, and does not
// hang or return undefined.
func TestEntryPointsBeforeReadinessReturnNotReady(t *testing.T) {
	m := bridge.NewModule()
	if m.Ready() {
		t.Fatal("a fresh module reports ready")
	}

	// It returns — the assertion that it does not hang. A deadlock would
	// fail the test by timing out rather than by returning.
	done := make(chan bridge.Envelope, 1)
	go func() { done <- m.Resolve(`{"target":"sd","quantity":"1"}`) }()

	var env bridge.Envelope
	select {
	case env = <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("resolve did not return before readiness; it hung")
	}

	if env.OK {
		t.Error("resolve succeeded on an unloaded module")
	}
	if env.Error == nil {
		t.Fatal("no error payload — the view would see undefined")
	}
	if env.Error.Code != bridge.CodeNotReady {
		t.Errorf("code = %q, want %q", env.Error.Code, bridge.CodeNotReady)
	}
	if env.Data != nil {
		t.Error("a not-ready failure carried a result payload")
	}

	// The readiness entry point says so too, rather than returning nothing.
	var ready bridge.Envelope
	if err := json.Unmarshal([]byte(m.CallJSON("ready", "")), &ready); err != nil {
		t.Fatal(err)
	}
	if ready.OK || ready.Error.Code != bridge.CodeNotReady {
		t.Errorf("ready reported %+v before loading", ready)
	}

	// And after loading, it is ready and resolve works.
	if env := m.Load(fixtureJSON(t)); !env.OK {
		t.Fatalf("load failed: %+v", env.Error)
	}
	if !m.Ready() {
		t.Error("the module is not ready after a successful load")
	}
	if env := m.Resolve(`{"target":"sd","quantity":"1"}`); !env.OK {
		t.Errorf("resolve failed after loading: %+v", env.Error)
	}
}

// SPEC-0002 REQ "Module Lifecycle and Readiness":
// WHEN the module instantiates successfully but the supplied Tier 1 artifact
// fails validation THEN the failure is reported as an invalid-artifact
// error, not as a module load failure.
func TestBadArtifactIsNotAModuleFailure(t *testing.T) {
	m := bridge.NewModule()

	cases := map[string]string{
		"not json":        `{ this is not json`,
		"wrong schema":    `{"schema_version":1,"game_version":"x","items":[],"recipes":[]}`,
		"no game version": `{"schema_version":2,"game_version":"","items":[],"recipes":[]}`,
		"dangling recipe": `{"schema_version":2,"game_version":"x","items":[],"recipes":[{"id":"r","output":"nope","method":"craft","inputs":[{"item":"x","quantity":1}]}]}`,
	}
	for name, artifact := range cases {
		t.Run(name, func(t *testing.T) {
			env := m.Load(artifact)
			if env.OK {
				t.Fatal("an invalid artifact loaded successfully")
			}
			if env.Error.Code != bridge.CodeInvalidArtifact {
				t.Errorf("code = %q, want %q — the module instantiated fine, the data is what is wrong",
					env.Error.Code, bridge.CodeInvalidArtifact)
			}
			// The module is still usable: it just has no data.
			if m.Ready() {
				t.Error("the module reports ready after a failed load")
			}
		})
	}

	// A good artifact still loads after a bad one, so a failed load does
	// not poison the module.
	if env := m.Load(fixtureJSON(t)); !env.OK {
		t.Errorf("a valid artifact failed to load after an invalid one: %+v", env.Error)
	}
}

// SPEC-0002 REQ "Boundary Surface":
// WHEN rollup or power is added in a later stage THEN it accepts and returns
// the same envelope shape, with no bespoke calling convention.
//
// RESERVED means the shape is fixed now. Both are declared with Resolve's
// signature and return a well-formed envelope today, so a view can wire them
// before they compute anything — and a reserved name that returned undefined
// would be indistinguishable from a typo.
func TestReservedStagesShareTheEnvelopeShape(t *testing.T) {
	m := loadedModule(t)

	for _, name := range []string{"rollup", "power"} {
		var env bridge.Envelope
		if err := json.Unmarshal([]byte(m.CallJSON(name, `{"target":"sd","quantity":"1"}`)), &env); err != nil {
			t.Fatalf("%s returned unparseable output: %v", name, err)
		}
		if env.OK {
			t.Errorf("%s reported success before its stage exists", name)
		}
		if env.Error == nil {
			t.Fatalf("%s returned no error payload — indistinguishable from a typo", name)
		}
		if env.Error.Code != bridge.CodeNotReady {
			t.Errorf("%s code = %q, want %q", name, env.Error.Code, bridge.CodeNotReady)
		}
		if !strings.Contains(env.Error.Message, name) {
			t.Errorf("%s message %q does not name the stage", name, env.Error.Message)
		}
		if env.ContractVersion != bridge.ContractVersion {
			t.Errorf("%s returned a different contract version", name)
		}
	}
}

// A malformed plan reaching an entry point is the caller's problem, and says
// so rather than crashing the module.
func TestMalformedPlanAtTheEntryPoint(t *testing.T) {
	m := loadedModule(t)

	for _, arg := range []string{`not json`, `{"quantity":"1"}`, `{"target":"sd","quantity":"0"}`} {
		var env bridge.Envelope
		if err := json.Unmarshal([]byte(m.CallJSON("resolve", arg)), &env); err != nil {
			t.Fatalf("the module returned unparseable output for %q: %v", arg, err)
		}
		if env.OK {
			t.Errorf("resolve accepted %q", arg)
		}
		if env.Error.Code != bridge.CodeMalformedInput {
			t.Errorf("%q: code = %q, want %q", arg, env.Error.Code, bridge.CodeMalformedInput)
		}
		if env.Data != nil {
			t.Errorf("%q: a malformed input produced a payload", arg)
		}
	}

	// The module still works afterwards.
	if env := m.Resolve(`{"target":"sd","quantity":"2"}`); !env.OK {
		t.Errorf("the module broke after a malformed call: %+v", env.Error)
	}
}
