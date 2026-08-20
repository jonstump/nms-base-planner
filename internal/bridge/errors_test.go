package bridge_test

import (
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"strings"
	"testing"

	"github.com/jonstump/nms-base-planner/internal/bridge"
	"github.com/jonstump/nms-base-planner/internal/domain"
)

// SPEC-0002 REQ "Sentinel Error Preservation":
// WHEN a plan names an item absent from the Tier 1 artifact
// THEN the error payload carries the code for unknown item, and the consumer
// branches on that code alone.
func TestSentinelIsDistinguishableWithoutStringParsing(t *testing.T) {
	_, err := domain.Resolve(loadFixture(t), domain.PlanInput{Target: "not_an_item", Quantity: 1})
	if err == nil {
		t.Fatal("expected the domain to reject an unknown target")
	}

	env := bridge.FailureFrom(err)
	if env.Error == nil {
		t.Fatal("no error payload")
	}
	if env.Error.Code != bridge.CodeUnknownItem {
		t.Errorf("code = %q, want %q", env.Error.Code, bridge.CodeUnknownItem)
	}
	if env.Data != nil {
		t.Error("a failure carried a result payload")
	}

	// A consumer branches on the code alone, consulting no substring of
	// the message.
	var branch string
	switch env.Error.Code {
	case bridge.CodeUnknownItem:
		branch = "unknown item"
	case bridge.CodeCycleDetected:
		branch = "cycle"
	default:
		branch = "unhandled"
	}
	if branch != "unknown item" {
		t.Errorf("a code-only switch reached the %q branch", branch)
	}
}

// The mapping is exhaustive over the sentinels internal/domain exports, and
// every code is distinct.
//
// The count is checked against the domain's source rather than a list
// written here, so a sentinel added there without a code fails this test
// instead of silently crossing as unclassified.
func TestEverySentinelHasADistinctCode(t *testing.T) {
	wired := map[string]struct {
		sentinel error
		code     string
	}{
		"ErrUnknownItem":     {domain.ErrUnknownItem, bridge.CodeUnknownItem},
		"ErrIllegalMethod":   {domain.ErrIllegalMethod, bridge.CodeIllegalMethod},
		"ErrCycleDetected":   {domain.ErrCycleDetected, bridge.CodeCycleDetected},
		"ErrMissingConstant": {domain.ErrMissingConstant, bridge.CodeMissingConstant},
		"ErrInvalidArtifact": {domain.ErrInvalidArtifact, bridge.CodeInvalidArtifact},
	}

	seen := map[string]string{}
	for name, m := range wired {
		got := bridge.CodeFor(fmt.Errorf("wrapped: %w", m.sentinel))
		if got != m.code {
			t.Errorf("%s mapped to %q, want %q", name, got, m.code)
		}
		if other, dup := seen[got]; dup {
			t.Errorf("code %q is shared by %s and %s", got, name, other)
		}
		seen[got] = name
		if got == bridge.CodeUnclassified {
			t.Errorf("%s maps to the reserved unclassified code", name)
		}
	}

	declared := domainSentinelNames(t)
	for _, name := range declared {
		if _, ok := wired[name]; !ok {
			t.Errorf("internal/domain declares %s but no code maps it; it would cross as unclassified", name)
		}
	}
	if len(declared) != len(wired) {
		t.Errorf("domain declares %d sentinels %v, %d are mapped", len(declared), declared, len(wired))
	}
}

// domainSentinelNames reads the Err* variables internal/domain declares, so
// "exhaustive" is checked against the source rather than against memory.
func domainSentinelNames(t *testing.T) []string {
	t.Helper()
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "../domain/errors.go", nil, 0)
	if err != nil {
		t.Fatalf("parsing the domain's errors: %v", err)
	}
	var out []string
	ast.Inspect(file, func(n ast.Node) bool {
		spec, ok := n.(*ast.ValueSpec)
		if !ok {
			return true
		}
		for _, name := range spec.Names {
			if strings.HasPrefix(name.Name, "Err") {
				out = append(out, name.Name)
			}
		}
		return true
	})
	if len(out) == 0 {
		t.Fatal("no sentinels found in the domain's errors.go, so this proves nothing")
	}
	return out
}

// SPEC-0002 REQ "Sentinel Error Preservation":
// WHEN a domain error's wrapped message text is reworded
// THEN the code it crosses with is unchanged.
//
// The test that earns its keep later, when someone improves a message. It
// holds by construction — CodeFor consults errors.Is and never the text —
// and this pins that, including mechanically.
func TestRewordingAMessageDoesNotChangeTheCode(t *testing.T) {
	original := fmt.Errorf("resolving Stasis Device: expanding Cryo-Pump: %w: %q",
		domain.ErrUnknownItem, "prod999")
	reworded := fmt.Errorf("could not resolve %q from the plan: %w", "prod999", domain.ErrUnknownItem)
	terse := fmt.Errorf("%w", domain.ErrUnknownItem)

	if original.Error() == reworded.Error() {
		t.Fatal("the two messages are identical, so this proves nothing")
	}

	first := bridge.CodeFor(original)
	if first != bridge.CodeUnknownItem {
		t.Fatalf("code = %q, want %q", first, bridge.CodeUnknownItem)
	}
	for _, variant := range []error{reworded, terse} {
		if got := bridge.CodeFor(variant); got != first {
			t.Errorf("rewording changed the code: %q vs %q", got, first)
		}
	}

	// And nothing in the mapping reads message text at all.
	assertNoTextMatching(t, "errors.go")
}

// assertNoTextMatching parses the source and fails if the code mapping
// inspects an error's message — the coupling this requirement forbids.
func assertNoTextMatching(t *testing.T, path string) {
	t.Helper()
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, path, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	var checked bool
	ast.Inspect(file, func(n ast.Node) bool {
		fn, ok := n.(*ast.FuncDecl)
		if !ok || fn.Name.Name != "CodeFor" {
			return true
		}
		checked = true
		ast.Inspect(fn, func(inner ast.Node) bool {
			call, ok := inner.(*ast.CallExpr)
			if !ok {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			pkg, ok := sel.X.(*ast.Ident)
			if !ok {
				return true
			}
			if pkg.Name == "strings" || sel.Sel.Name == "Error" {
				t.Errorf("%s: %s.%s inside CodeFor — codes must not depend on message text",
					fset.Position(call.Pos()), pkg.Name, sel.Sel.Name)
			}
			return true
		})
		return false
	})
	if !checked {
		t.Fatalf("CodeFor was not found in %s, so this proves nothing", path)
	}
}

// SPEC-0002 REQ "Sentinel Error Preservation":
// WHEN an error matches none of the defined sentinels
// THEN it crosses with the reserved unclassified code, not with the code of
// an unrelated sentinel.
//
// The one an implementation is most likely to get wrong by being helpful.
func TestUnmatchedErrorCrossesAsUnclassified(t *testing.T) {
	cases := []error{
		errors.New("something nobody has a sentinel for"),
		fmt.Errorf("wrapped: %w", errors.New("still unclassified")),
		// Deliberately worded to look like sentinels they do not wrap.
		errors.New("unknown item: this message resembles a sentinel but wraps none"),
		errors.New("cycle detected somewhere, allegedly"),
		errors.New("invalid tier 1 artifact"),
	}
	for _, err := range cases {
		if got := bridge.CodeFor(err); got != bridge.CodeUnclassified {
			t.Errorf("%q crossed as %q, want the reserved unclassified code", err, got)
		}
	}

	env := bridge.FailureFrom(errors.New("unknown item: a lookalike"))
	if env.Error.Code != bridge.CodeUnclassified {
		t.Errorf("envelope code = %q, want unclassified", env.Error.Code)
	}
	if env.OK {
		t.Error("an unclassified failure reported success")
	}
}

// SPEC-0002 REQ "Contract Versioning":
// WHEN the view is built against one contract version and loads a module
// reporting another THEN it reports a mismatch naming both versions, and
// does not attempt to consume the payload.
func TestVersionMismatchNamesBothVersions(t *testing.T) {
	if err := bridge.CheckVersion(bridge.ContractVersion); err != nil {
		t.Errorf("matching versions reported %v", err)
	}

	const stale = "0.9.0"
	err := bridge.CheckVersion(stale)
	if err == nil {
		t.Fatal("a mismatched version was accepted")
	}
	if !errors.Is(err, bridge.ErrVersionMismatch) {
		t.Errorf("error = %v, want ErrVersionMismatch", err)
	}
	for _, want := range []string{stale, bridge.ContractVersion} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("message %q does not name version %q", err, want)
		}
	}

	env := bridge.FailureFrom(err)
	if env.Error.Code != bridge.CodeVersionMismatch {
		t.Errorf("code = %q, want %q", env.Error.Code, bridge.CodeVersionMismatch)
	}
	if env.Data != nil {
		t.Error("a version mismatch carried a result payload to consume")
	}
}

// SPEC-0002 REQ "Error Handling Standards":
// WHEN the view passes input that cannot be decoded into a valid plan
// THEN the failure names what could not be decoded, and no computation is
// attempted.
func TestMalformedInputNamesWhatFailed(t *testing.T) {
	cases := []struct {
		name string
		plan bridge.Plan
		want string
	}{
		{"no target", bridge.Plan{Quantity: "1"}, "no target"},
		{"quantity is not a number", bridge.Plan{Target: "sd", Quantity: "lots"}, "lots"},
		{"fractional quantity", bridge.Plan{Target: "sd", Quantity: "3/2"}, "whole number"},
		{"zero quantity", bridge.Plan{Target: "sd", Quantity: "0"}, "not positive"},
		{"negative quantity", bridge.Plan{Target: "sd", Quantity: "-4"}, "not positive"},
		{"method outside the vocabulary", bridge.Plan{
			Target: "sd", Quantity: "1",
			Methods: map[string]string{"gla": "buy"},
		}, "buy"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in, err := bridge.DecodePlanStrict(tc.plan)
			if err == nil {
				t.Fatalf("decoded %+v without complaint", tc.plan)
			}
			if !errors.Is(err, bridge.ErrMalformedInput) {
				t.Errorf("error = %v, want ErrMalformedInput", err)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("message %q does not name %q", err, tc.want)
			}
			// No computation attempted: nothing usable came back.
			if in.Target != "" || in.Quantity != 0 {
				t.Errorf("a partial plan was returned alongside the error: %+v", in)
			}
			if code := bridge.CodeFor(err); code != bridge.CodeMalformedInput {
				t.Errorf("code = %q, want %q", code, bridge.CodeMalformedInput)
			}
		})
	}

	in, err := bridge.DecodePlanStrict(bridge.Plan{Target: "sd", Quantity: "4"})
	if err != nil {
		t.Fatalf("a valid plan was refused: %v", err)
	}
	if in.Target != "sd" || in.Quantity != 4 {
		t.Errorf("decoded %+v, want sd x4", in)
	}
}

// SPEC-0002 REQ "Error Handling Standards":
// WHEN a call fails because the module is not ready, versus because the
// input was malformed THEN the two failures carry different codes.
func TestNotReadyAndMalformedAreDistinct(t *testing.T) {
	notReady := fmt.Errorf("resolve: %w", bridge.ErrNotReady)
	malformed := fmt.Errorf("decoding plan: %w", bridge.ErrMalformedInput)

	nr, mf := bridge.CodeFor(notReady), bridge.CodeFor(malformed)
	if nr == mf {
		t.Fatalf("both failures carry %q; a consumer cannot tell them apart", nr)
	}
	if nr != bridge.CodeNotReady {
		t.Errorf("not-ready code = %q, want %q", nr, bridge.CodeNotReady)
	}
	if mf != bridge.CodeMalformedInput {
		t.Errorf("malformed code = %q, want %q", mf, bridge.CodeMalformedInput)
	}

	// Neither is the artifact's problem, which is a third distinct kind:
	// the artifact is ours, the input is theirs.
	bad := fmt.Errorf("loading: %w", domain.ErrInvalidArtifact)
	if code := bridge.CodeFor(bad); code == mf || code == nr {
		t.Errorf("an invalid artifact shares a code with an input or lifecycle failure: %q", code)
	}
}

// A domain error wrapped by a boundary sentinel keeps the domain's code:
// the boundary's own kinds are matched after the domain's, so ours never
// shadow theirs.
func TestDomainCodeIsNotShadowedByABoundarySentinel(t *testing.T) {
	wrapped := fmt.Errorf("%w: %w", bridge.ErrMalformedInput, domain.ErrIllegalMethod)
	if got := bridge.CodeFor(wrapped); got != bridge.CodeIllegalMethod {
		t.Errorf("code = %q, want %q — the domain's kind is the more specific one",
			got, bridge.CodeIllegalMethod)
	}
}

// A nil error asked for an envelope says so rather than emitting an empty
// failure that looks like a real one.
func TestFailureFromNilIsHonest(t *testing.T) {
	env := bridge.FailureFrom(nil)
	if env.OK {
		t.Error("an envelope built from no error reported success")
	}
	if env.Error == nil || env.Error.Message == "" {
		t.Fatal("an empty error payload")
	}
	if env.Error.Code != bridge.CodeUnclassified {
		t.Errorf("code = %q, want unclassified", env.Error.Code)
	}
	if got := bridge.CodeFor(nil); got != "" {
		t.Errorf("CodeFor(nil) = %q, want the empty string", got)
	}
}
